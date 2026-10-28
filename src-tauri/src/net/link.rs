//! 一条 TCP 直连链路。
//!
//! 三个决定写在这里，因为它们错了以后表现是「偶尔卡住 / 偶尔丢第一条消息」
//! 这种最难查的形态。
//!
//! **一、重复链路谁留谁去。** 双方同时发现对方时都会拨号，于是同一对人之间
//! 会出现两条 TCP。规则必须**对称**，否则两边各自关掉一条、留下对方的另一条，
//! 结果两条都死。这里用「拨号方 id 小于接听方 id 的那条留下」：
//! 对同一对链路，两边算出来的答案相同。
//!
//! **二、TCP_NODELAY 必须开。** 聊天消息都是几百字节的小包，Nagle 算法会把它们
//! 攒起来等确认，实测能拖到 200 ms —— 在局域网上这就是「打字发出去卡一下」。
//! 这条链路上没有省带宽的需求，局域网带宽是免费的。
//!
//! **三、读缓冲绝不能重建。** `BufReader` 会预读：对端把 hello 和第一条消息连着
//! 发过来时，第一条消息已经在缓冲区里了。如果握手函数返回时丢掉那个 reader、
//! 让调用方重新构造一个，那几十个字节不会留下任何日志，表现就是「偶尔丢一条」。
//! 所以 `Handshake` 把 reader 和 writer **一起**交出来。

use crate::net::frames::{read_frame, write_frame};
use std::io::{self, BufReader, BufWriter};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// 握手帧的格式标记。和发现信标一样带版本号，将来改协议时能干净地拒绝旧客户端。
const HELLO: u64 = 0x4241_4B45_5202;

/// 等对方 hello 的上限。局域网上真机器都在毫秒级回来，10 秒是「它压根不想说」。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// 一次写调用的上限。
///
/// 这一条防的是**发送方被对方拖住**：`Link::send` 持着 `writer` 的锁写，
/// 对端只要连着但不读（不在 `read`，TCP 窗口很快填满），`write` 就会一直
/// 阻塞 —— 而它持锁。于是所有走广播的 `net_*` IPC 命令全部冻住，
/// 表现是「界面偶尔整个卡死几十秒」，谁也想不到是被一个不读数据的
/// 对端拽住的。30 秒后写超时返回错误，调用方丢链路，锁跟着放掉。
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// 一条已建立的链路（只占写半边；读半边被读线程拿走）。
pub struct Link {
    /// 对端设备编号
    pub peer_id: String,
    /// 谁拨的号（用于去重）
    pub dialer: String,
    /// 谁接的听
    pub acceptor: String,
    /// 对端地址，只用于日志与界面显示
    pub addr: SocketAddr,
    /// 对端的自我介绍（握手时带过来）。可能比发现信标更新。
    pub info: serde_json::Value,
    writer: Mutex<BufWriter<TcpStream>>,
    closed: AtomicBool,
}

impl Link {
    /// 这条链路按去重规则是否该留下。
    ///
    /// 「拨号方编号 < 接听方编号」留下。字符串比较在这里是稳定的：
    /// 编号是定长大写十六进制，字典序和数值序一致。
    pub fn should_keep(&self) -> bool {
        self.dialer < self.acceptor
    }

    pub fn send(&self, payload: &[u8]) -> io::Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(io::Error::new(io::ErrorKind::NotConnected, "链路已关闭"));
        }
        let mut w = self.writer.lock().unwrap();
        // `&mut *w` 把 MutexGuard 拆成里面的 BufWriter：guard 本身不实现 Write
        write_frame(&mut *w, payload)
    }

    /// 关掉链路。幂等：重复调用直接返回成功。
    ///
    /// 先 `shutdown` 再置标记 —— 顺序反过来的话，一个正在 `send` 的线程会先看到
    /// 「已关闭」返回错误，而底下那条 TCP 还开着，对端要等到超时才知道我们走了。
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(w) = self.writer.lock() {
            let _ = w.get_ref().shutdown(Shutdown::Both);
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
}

/// 握手结果。reader 必须原样交给读线程，不能重建。
///
/// 派生 `Debug` 是为了自测里能用 `unwrap_err()`；注意它的 Debug 会把整条
/// 连接的缓冲句柄打出来，所以只在测试路径上用。
#[derive(Debug)]
pub struct Handshake {
    pub peer_id: String,
    pub info: serde_json::Value,
    pub reader: BufReader<TcpStream>,
    pub writer: BufWriter<TcpStream>,
    pub addr: SocketAddr,
}

/// 在一条刚建立的 TCP 上完成握手，返回对方是谁。
///
/// 双方都**立刻发**自己的 hello，然后读对方的 —— 没有「谁先说话」的分工，
/// 所以不存在一方等着另一方先开口的死锁。
pub fn handshake(
    stream: TcpStream,
    self_id: &str,
    info: &serde_json::Value,
) -> io::Result<Handshake> {
    handshake_within(stream, self_id, info, HANDSHAKE_TIMEOUT)
}

/// `handshake` 的本体，超时可注入 —— 自测要验「对端不说话就会被放弃」，
/// 但不能为此等满 10 秒。
pub fn handshake_within(
    stream: TcpStream,
    self_id: &str,
    info: &serde_json::Value,
    timeout: Duration,
) -> io::Result<Handshake> {
    // 握手本身也是小包，一开始就关掉 Nagle
    stream.set_nodelay(true)?;
    // 握手**有**超时，握手完的读循环**没有**（下面清掉）。两件事必须分开：
    // 对端连上却不发 hello（半开连接、端口扫描、或者就是想占着）会让
    // `read_frame` 永远阻塞 —— 而每个入站连接占一个线程，没有上限，
    // 攒够几百条这样的连接就是一次拒绝服务。反过来，读循环带超时也不行：
    // 聊天链路空闲几分钟完全正常，超时会被当成断开，于是每次开口前都要重连。
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    let addr = stream.peer_addr()?;
    let mut writer = BufWriter::new(stream.try_clone()?);
    let mut reader = BufReader::new(stream);

    let hello = serde_json::to_vec(&serde_json::json!({
        "b": HELLO,
        "id": self_id,
        "info": info,
    }))
    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_frame(&mut writer, &hello)?;

    let raw = read_frame(&mut reader)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "对端在握手前就断开了"))?;
    let v: serde_json::Value = serde_json::from_slice(&raw)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("握手帧不是 JSON：{e}")))?;
    if v.get("b").and_then(|x| x.as_u64()) != Some(HELLO) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "对端不是 BAKER（握手帧标记不匹配）—— 连错端口了？",
        ));
    }
    let peer_id = v
        .get("id")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "握手帧没有合法的 id"))?
        .to_string();

    // 对方自称是**我本人** —— 直接断开。
    //
    // hello 里的 id 是对方自己填的字符串，没有任何东西把它和公钥绑起来，
    // 所以任何人都能把 id 填成我的。而 `node.rs` 会把这条链路的每一帧都以
    // `from = 我的 id` 投递上去（见那边的读循环），于是上层 `node.ts` 就得靠
    // `event.from === selfId` 那条守卫把它顶回来 —— 那是**上层**的补救，
    // 而且只挡住了「自称是我」，挡不住「自称是我认识的某个人」。
    //
    // 在最低这一层就断掉，是因为「一条链路自称是我本人」无论从哪个角度看都
    // 不可能是正常流量：本机不会连自己（自己的组播包在发现阶段就被丢了，
    // 拨号侧也有守卫）。拒绝它不需要任何信任假设，也不存在误伤。
    if peer_id == self_id {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "对端自称是本人（hello 里的 id 等于本机 id）",
        ));
    }

    // 握手过了，读半边回到「可以一直等」—— 聊天链路空闲是常态，不是故障。
    // 写超时**保留**（见 `WRITE_TIMEOUT`）。
    reader.get_ref().set_read_timeout(None)?;

    Ok(Handshake {
        peer_id,
        info: v.get("info").cloned().unwrap_or(serde_json::Value::Null),
        reader,
        writer,
        addr,
    })
}

impl Handshake {
    /// 拆成「写半边（进链路表）」和「读半边（进读线程）」。
    ///
    /// `dialer_self`：这条 TCP 是不是我们主动拨的。去重规则依赖这个事实，不能靠猜。
    pub fn split(self, self_id: &str, dialer_self: bool) -> (Link, BufReader<TcpStream>) {
        // `handshake` 里已经设过一次，这里在**产生 Link 的唯一位置**再钉一次：
        // 不变量（链路一律不开 Nagle）写在产生点上，就不用指望每个拿到
        // `Handshake` 的调用方都记得。`Handshake` 的字段是 pub 的，
        // 自测和以后的代码都可能绕过 `handshake` 直接拼一个出来。
        // 开关失败只是退回 Nagle（消息会晚几十毫秒），不影响正确性，所以不阻断建链。
        let _ = self.writer.get_ref().set_nodelay(true);
        let (dialer, acceptor) = if dialer_self {
            (self_id.to_string(), self.peer_id.clone())
        } else {
            (self.peer_id.clone(), self_id.to_string())
        };
        let link = Link {
            peer_id: self.peer_id,
            dialer,
            acceptor,
            addr: self.addr,
            info: self.info,
            writer: Mutex::new(self.writer),
            closed: AtomicBool::new(false),
        };
        (link, self.reader)
    }
}

/// 这个地址是不是「本网段里可以直连的」。
///
/// 挡掉发现阶段可能混进来的奇怪地址（0.0.0.0、组播、保留段）。
/// 环回**允许**通过：同机双开是合法用法，也是自测的唯一办法。
pub fn is_dialable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !v4.is_unspecified()
                && !v4.is_multicast()
                && !v4.is_broadcast()
                && !(v4.octets()[0] == 169 && v4.octets()[1] == 254) // APIPA：对面没拿到地址
        }
        IpAddr::V6(v6) => !v6.is_unspecified() && !v6.is_multicast(),
    }
}

#[cfg(test)]
#[allow(non_snake_case)] // 自测名写成中文：读起来是一句人话，比拼音或英文缩写强
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, TcpListener};

    fn pair() -> (TcpStream, TcpStream) {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = l.local_addr().unwrap();
        let a = TcpStream::connect(addr).unwrap();
        let (b, _) = l.accept().unwrap();
        (a, b)
    }

    #[test]
    fn 对端连上却不发握手帧会被超时放弃() {
        // 这一条防的是「连上就不说话」：每个入站连接一个线程，而
        // `read_frame` 不带超时就会永远阻塞在那儿（见 `HANDSHAKE_TIMEOUT`）。
        // 用注入的 300 ms，不等真的 10 秒。
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = l.local_addr().unwrap();
        // 连上就什么都不发，也不关 —— 这正是半开连接的样子。
        let _silent = TcpStream::connect(addr).unwrap();
        let (s, _) = l.accept().unwrap();

        let started = std::time::Instant::now();
        let err = handshake_within(s, "AAA", &serde_json::json!({}), Duration::from_millis(300))
            .expect_err("对端不说话，握手必须失败");
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_secs(3),
            "应该由超时结束，实际等了 {elapsed:?}（是不是把超时清成了 None？）",
        );
        // 超时在 Windows 上是 TimedOut、在别处可能是 WouldBlock，别写死。
        assert!(
            matches!(
                err.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ),
            "错误类型是 {:?}：{err}",
            err.kind(),
        );
    }

    #[test]
    fn 自称是本人id的握手被拒() {
        // hello 里的 id 是对方自己填的，没有和公钥绑定，所以谁都能填成我的。
        // 而 `node.rs` 会把这条链路的每一帧都以 `from = 我的 id` 投上去 ——
        // 上层只能靠 `event.from === selfId` 那条守卫顶回来。
        //
        // 这一条守的是「最低这一层也拒绝」：两边都用 "AAA"，握手必须失败。
        let (a, b) = pair();
        let tb = std::thread::spawn(move || handshake(b, "AAA", &serde_json::json!({})));
        let err = handshake(a, "AAA", &serde_json::json!({}))
            .expect_err("对端自称是本人，握手必须失败");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData, "错误类型是 {:?}：{err}", err.kind());

        // 对面那一侧也会看到「对面自称是我」—— 它拿到的 id 同样是 "AAA"。
        let other = tb.join().unwrap();
        assert!(other.is_err(), "另一侧也该拒绝，实际 {other:?}");
    }

    #[test]
    fn 握手成功后读回半边能一直等而写半边有超时() {
        // 两条不变量，方向相反，很容易在改超时的时候弄反：
        //   · 读半边必须**没有**超时 —— 聊天链路空闲几分钟是常态，
        //     带超时的话每次开口前都要重连（表现是「偶尔第一条消息慢」）；
        //   · 写半边必须**有**超时 —— `Link::send` 持着锁写，对端不读就会
        //     永远阻塞，把所有走广播的 IPC 一起冻住。
        let (a, b) = pair();
        let tb = std::thread::spawn(move || handshake(b, "BBB", &serde_json::json!({})).unwrap());
        let ha = handshake(a, "AAA", &serde_json::json!({})).unwrap();
        let hb = tb.join().unwrap();

        assert_eq!(ha.reader.get_ref().read_timeout().unwrap(), None, "读半边不该有超时");
        assert_eq!(
            ha.reader.get_ref().write_timeout().unwrap(),
            Some(WRITE_TIMEOUT),
            "写半边必须留超时",
        );
        assert_eq!(hb.reader.get_ref().read_timeout().unwrap(), None);
        assert_eq!(
            hb.reader.get_ref().write_timeout().unwrap(),
            Some(WRITE_TIMEOUT),
        );
    }

    #[test]
    fn 握手双方各自认出对方() {
        let (a, b) = pair();
        let ia = serde_json::json!({"name": "甲"});
        let ib = serde_json::json!({"name": "乙"});
        let ta = std::thread::spawn(move || handshake(a, "AAA", &ia).unwrap().peer_id);
        let tb = std::thread::spawn(move || handshake(b, "BBB", &ib).unwrap().peer_id);
        assert_eq!(ta.join().unwrap(), "BBB");
        assert_eq!(tb.join().unwrap(), "AAA");
    }

    #[test]
    fn 握手带过来的自我介绍能拿到() {
        let (a, b) = pair();
        let ia = serde_json::json!({"name": "甲", "fp": "XXXX"});
        let ib = serde_json::json!({"name": "乙"});
        let ta = std::thread::spawn(move || {
            let h = handshake(a, "AAA", &ia).unwrap();
            (h.peer_id, h.info, h.addr)
        });
        let tb = std::thread::spawn(move || handshake(b, "BBB", &ib).unwrap().peer_id);
        let (pid, info, addr) = ta.join().unwrap();
        assert_eq!(pid, "BBB");
        assert_eq!(info["name"], serde_json::Value::String("乙".into()));
        assert_eq!(addr.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(tb.join().unwrap(), "AAA");
    }

    /// 预读 bug 的回归测试。
    ///
    /// 对端把 hello 和随后的两帧**连着**发过来（真客户端就是这个时序，中间不会有
    /// 任何停顿）。如果握手实现里重建了 reader，这两帧就被吃掉了。
    #[test]
    fn 紧跟在握手后的第一帧不会丢() {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = l.local_addr().unwrap();

        let server = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let h = handshake(s, "SERVER", &serde_json::json!({})).unwrap();
            let (link, mut reader) = h.split("SERVER", false);
            // 关键：不 sleep，连着发
            link.send(br#"{"t":"first"}"#).unwrap();
            link.send(br#"{"t":"second"}"#).unwrap();
            let from_client = read_frame(&mut reader).unwrap().unwrap();
            (link, from_client)
        });

        let s = TcpStream::connect(addr).unwrap();
        let h = handshake(s, "CLIENT", &serde_json::json!({})).unwrap();
        let (link, mut reader) = h.split("CLIENT", true);

        // 这两帧必须都在 —— 就是回归点
        assert_eq!(
            read_frame(&mut reader).unwrap().unwrap(),
            br#"{"t":"first"}"#.to_vec()
        );
        assert_eq!(
            read_frame(&mut reader).unwrap().unwrap(),
            br#"{"t":"second"}"#.to_vec()
        );

        link.send(br#"{"t":"from-client"}"#).unwrap();

        let (server_link, from_client) = server.join().unwrap();
        assert_eq!(from_client, br#"{"t":"from-client"}"#.to_vec());
        assert_eq!(server_link.peer_id, "CLIENT");
        assert_eq!(server_link.dialer, "CLIENT");
        assert_eq!(server_link.acceptor, "SERVER");
    }

    #[test]
    fn 对面不说话时报错而不是永久挂住() {
        let (a, b) = pair();
        drop(b); // 关掉对端，握手应该立刻失败
        let err = handshake(a, "AAA", &serde_json::json!({})).unwrap_err();
        assert!(
            matches!(
                err.kind(),
                io::ErrorKind::UnexpectedEof
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::BrokenPipe
                    | io::ErrorKind::ConnectionAborted
            ),
            "意外的错误类型：{err:?}"
        );
    }

    #[test]
    fn 连到非BAKER端口会被明确拒绝() {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            use std::io::Write;
            if let Ok((mut s, _)) = l.accept() {
                // 回一段长度合法、但不是 BAKER 的 JSON
                let body = br#"{"hello":"world"}"#;
                let _ = s.write_all(&(body.len() as u32).to_be_bytes());
                let _ = s.write_all(body);
                let _ = s.flush();
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        });
        let s = TcpStream::connect(addr).unwrap();
        let err = handshake(s, "AAA", &serde_json::json!({})).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("不是 BAKER"), "{}", err);
    }

    /// 同一对人之间两条链路同时存在时，两边必须算出**同一个**答案。
    ///
    /// 这是整个去重规则唯一真正重要的一点：如果两边各自留下不同的一条，
    /// 结果就是两条都被对方关掉，表现成「他们俩永远连不上，但跟别人都正常」。
    #[test]
    fn 两条链路同时存在时两边答案一致且恰好留一条() {
        let mk = |peer: &str, self_id: &str, dialer_self: bool| {
            let (s, _keep_alive) = pair();
            let h = Handshake {
                peer_id: peer.into(),
                info: serde_json::Value::Null,
                reader: BufReader::new(s.try_clone().unwrap()),
                writer: BufWriter::new(s),
                addr: "127.0.0.1:1".parse().unwrap(),
            };
            h.split(self_id, dialer_self).0
        };

        // 世界上真实存在的两条链路：
        let a_dials_b = mk("BBB", "AAA", true); // dialer=AAA acceptor=BBB
        let b_dials_a = mk("AAA", "BBB", true); // dialer=BBB acceptor=AAA

        // A 的进程里看到的同样是这两条（一条自己拨的，一条对方拨来的）
        let a_sees_out = mk("BBB", "AAA", true);
        let a_sees_in = mk("BBB", "AAA", false);

        // B 的进程里看到的也是这两条
        let b_sees_out = mk("AAA", "BBB", true);
        let b_sees_in = mk("AAA", "BBB", false);

        // 同一对链路，在谁的进程里算出来的结论都必须一样
        assert_eq!(a_dials_b.should_keep(), a_sees_out.should_keep());
        assert_eq!(a_dials_b.should_keep(), b_sees_in.should_keep());
        assert_eq!(b_dials_a.should_keep(), a_sees_in.should_keep());
        assert_eq!(b_dials_a.should_keep(), b_sees_out.should_keep());

        // 而且恰好留一条
        assert!(
            a_dials_b.should_keep() ^ b_dials_a.should_keep(),
            "两条都留或都弃都是死锁"
        );
    }

    #[test]
    fn 去重规则按事实填拨号方与接听方() {
        let (s, _peer) = pair();
        let h = Handshake {
            peer_id: "BBB".into(),
            info: serde_json::Value::Null,
            reader: BufReader::new(s.try_clone().unwrap()),
            writer: BufWriter::new(s),
            addr: "127.0.0.1:1".parse().unwrap(),
        };
        // 我们拨的
        let (l, _r) = h.split("AAA", true);
        assert_eq!(l.dialer, "AAA");
        assert_eq!(l.acceptor, "BBB");
        assert!(l.should_keep(), "AAA < BBB，我们拨的这条该留下");
    }

    #[test]
    fn 去重规则在被动一侧让位() {
        let (s, _peer) = pair();
        let h = Handshake {
            peer_id: "AAA".into(),
            info: serde_json::Value::Null,
            reader: BufReader::new(s.try_clone().unwrap()),
            writer: BufWriter::new(s),
            addr: "127.0.0.1:1".parse().unwrap(),
        };
        // BBB 接听 AAA 拨来的：这条该留下（因为拨号方 AAA < 接听方 BBB）
        let (l, _r) = h.split("BBB", false);
        assert_eq!(l.dialer, "AAA");
        assert_eq!(l.acceptor, "BBB");
        assert!(l.should_keep());
    }

    #[test]
    fn 关闭是幂等的且之后发送会失败() {
        let (s, _peer) = pair();
        let h = Handshake {
            peer_id: "BBB".into(),
            info: serde_json::Value::Null,
            reader: BufReader::new(s.try_clone().unwrap()),
            writer: BufWriter::new(s),
            addr: "127.0.0.1:1".parse().unwrap(),
        };
        let (link, _r) = h.split("AAA", true);
        assert!(!link.is_closed());
        link.close();
        assert!(link.is_closed());
        link.close(); // 第二次不该 panic
        let err = link.send(b"hi").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotConnected);
    }

    #[test]
    fn 关了Nagle之后小包能立刻到达() {
        let (a, b) = pair();
        let h = Handshake {
            peer_id: "BBB".into(),
            info: serde_json::Value::Null,
            reader: BufReader::new(a.try_clone().unwrap()),
            writer: BufWriter::new(a),
            addr: "127.0.0.1:1".parse().unwrap(),
        };
        let (link, _r) = h.split("AAA", true);
        assert!(
            link.writer.lock().unwrap().get_ref().nodelay().unwrap(),
            "into_link 之后 nodelay 必须为真"
        );
        link.send(b"tiny").unwrap();
        let mut r = BufReader::new(b);
        assert_eq!(read_frame(&mut r).unwrap().unwrap(), b"tiny");
    }

    #[test]
    fn 可拨号地址的判定() {
        assert!(is_dialable(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5))));
        assert!(is_dialable(IpAddr::V4(Ipv4Addr::new(172, 29, 99, 71))));
        assert!(is_dialable(IpAddr::V4(Ipv4Addr::LOCALHOST)), "同机双开要允许");
        assert!(!is_dialable(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(!is_dialable(IpAddr::V4(Ipv4Addr::BROADCAST)));
        assert!(!is_dialable(IpAddr::V4(Ipv4Addr::new(239, 255, 66, 66))), "组播");
        assert!(!is_dialable(IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))), "APIPA");
    }
}
