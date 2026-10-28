//! 局域网发现：UDP 组播 **和** 子网广播，两套一起发。
//!
//! 为什么不是只发组播：**很多家用/商用 Wi-Fi AP 默认丢组播包**（省电特性），
//! 尤其是跨 AP 漫游时；反过来有些企业网里广播被禁而组播能过。
//! 两套一起发的成本是每个信标多几十字节，收益是「换一个网络环境就发现不了」
//! 这个最难排查的故障直接消失。
//!
//! 信标里带的是**身份信息 + 数据端口**，不带任何聊天内容。发现阶段的信任度是零：
//! 看到别人 ≠ 信任别人，真正的信任仍然由 E2E 加密和指纹核对决定。
//!
//! 另外一条纪律：**不信信标里自称的地址**。IP 一律从 UDP 包的来源地址取。
//! 否则任何人都能广播一条「某人的 id 在 1.2.3.4」把别人引到错误的地方。

use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// 组播组地址。选这个网段是因为它在「本地管理」范围内，路由器不会转发出去 ——
/// 发现流量在物理上就出不了局域网。
pub const GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 66, 66);

/// 信标间隔。3 秒是「上线后几乎立刻可见」与「待机流量可忽略」的折中：
/// 一条信标约 300 字节，3 秒一条 = 0.1 KB/s。
pub const BEACON_EVERY: Duration = Duration::from_secs(3);

/// 多久没听到就认为对方走了。
///
/// 必须明显大于信标间隔（这里是 4 倍），否则一次 GC 停顿或 Wi-Fi 抖动
/// 就会让整个联系人列表闪一下 —— 「人还在，名字消失又出现」比晚几秒发现难看得多。
pub const PEER_TIMEOUT: Duration = Duration::from_secs(12);

/// 收到的一个节点。
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct DiscoveredPeer {
    /// 设备编号（和界面上显示的 UID 同一个）。发现表以它为主键，**不用 IP**：
    /// DHCP 换地址、笔记本换个 Wi-Fi 之后，同一个人还是同一个人。
    pub id: String,
    /// 对方 TCP 数据端口
    pub port: u16,
    /// 对方的 IP —— 从 UDP 包的来源地址取，不信信标里自称的
    pub ip: Ipv4Addr,
    /// 对方自称的身份信息（名字/头像/key/指纹）。Rust 不解释，原样交给前端。
    pub info: serde_json::Value,
}

impl DiscoveredPeer {
    pub fn addr(&self) -> SocketAddr {
        SocketAddr::V4(SocketAddrV4::new(self.ip, self.port))
    }
}

/// 发现事件的出口。
pub type Sink = Arc<dyn Fn(DiscoverEvent) + Send + Sync>;

#[derive(Clone, Debug)]
pub enum DiscoverEvent {
    /// 第一次看到这个节点，或者它换了地址/端口/自我介绍后重新出现
    Found(DiscoveredPeer),
    /// 超过 `PEER_TIMEOUT` 没再听到
    Gone(String),
}

/// 我们自己广播出去的自我介绍。
#[derive(Clone, Debug)]
pub struct Beacon {
    pub id: String,
    pub port: u16,
    pub info: serde_json::Value,
}

const MAGIC: u64 = 0x4241_4B45_5201; // "BAKER" + 版本 1

pub struct Discoverer {
    stop: Arc<AtomicBool>,
    /// 一次性「马上再发一轮」信号，见 `announce_now`
    pulse: Arc<AtomicBool>,
    peers: Arc<Mutex<HashMap<String, (DiscoveredPeer, Instant)>>>,
    beacon: Arc<Mutex<Beacon>>,
    handles: Mutex<Vec<JoinHandle<()>>>,
}

impl Discoverer {
    /// 起发现：收信标 + 发信标 + 过期回收。
    ///
    /// `port` 同时用作 UDP 端口。同一台机器上的第二个实例靠 `SO_REUSEADDR` 共存。
    pub fn start(port: u16, beacon: Beacon, sink: Sink) -> std::io::Result<Self> {
        let socket = Arc::new(bind_shared(port)?);
        // 收信标要有超时，否则 stop() 之后线程要等下一个包才醒
        socket.set_read_timeout(Some(Duration::from_millis(400)))?;
        // TTL=1：包在物理上出不了本网段
        let _ = socket.set_multicast_ttl_v4(1);
        let _ = socket.set_multicast_loop_v4(true);

        let stop = Arc::new(AtomicBool::new(false));
        let pulse = Arc::new(AtomicBool::new(false));
        let peers: Arc<Mutex<HashMap<String, (DiscoveredPeer, Instant)>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let beacon = Arc::new(Mutex::new(beacon));

        let mut handles = Vec::new();

        // ── 收 ────────────────────────────────────────────────────────────
        {
            let socket = socket.clone();
            let stop = stop.clone();
            let peers = peers.clone();
            let sink = sink.clone();
            let self_id = beacon.lock().unwrap().id.clone();
            handles.push(thread::spawn(move || {
                let mut buf = [0u8; 8192];
                while !stop.load(Ordering::Relaxed) {
                    let (n, from) = match socket.recv_from(&mut buf) {
                        Ok(v) => v,
                        Err(e) => {
                            // 超时是正常节拍；连接被拒（Windows 上收到 ICMP
                            // 端口不可达会这样）也不该让发现线程退出。
                            match e.kind() {
                                std::io::ErrorKind::WouldBlock
                                | std::io::ErrorKind::TimedOut
                                | std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionRefused => {}
                                _ => log::debug!("发现：收包失败 {e}"),
                            }
                            continue;
                        }
                    };
                    let ip = match from {
                        SocketAddr::V4(v4) => *v4.ip(),
                        SocketAddr::V6(_) => continue, // 发现只走 IPv4
                    };
                    let Some(peer) = parse_beacon(&buf[..n], ip) else {
                        continue;
                    };
                    if peer.id == self_id {
                        continue; // 自己的组播回路
                    }

                    // 「要不要报告」必须在锁内决定：两个线程可能同时收到
                    // 同一个人的信标，锁外判断会报两次 Found。
                    let changed = {
                        let mut table = peers.lock().unwrap();
                        let known = table.get(&peer.id).map(|(p, _)| p.clone());
                        table.insert(peer.id.clone(), (peer.clone(), Instant::now()));
                        known.as_ref() != Some(&peer)
                    };
                    if changed {
                        sink(DiscoverEvent::Found(peer));
                    }
                }
            }));
        }

        // ── 发 ────────────────────────────────────────────────────────────
        {
            let socket = socket.clone();
            let stop = stop.clone();
            let pulse = pulse.clone();
            let beacon = beacon.clone();
            handles.push(thread::spawn(move || {
                let targets = beacon_targets(port);
                while !stop.load(Ordering::Relaxed) {
                    let b = beacon.lock().unwrap().clone();
                    match build_beacon(&b) {
                        Ok(payload) => {
                            for t in &targets {
                                if let Err(e) = socket.send_to(&payload, t) {
                                    // 某一个目标发不出去是常态（比如没有默认路由时
                                    // 受限广播会失败），不升级成错误。
                                    log::debug!("发现：发信标到 {t} 失败 {e}");
                                }
                            }
                        }
                        Err(e) => log::debug!("发现：信标序列化失败 {e}"),
                    }
                    // 分段睡，让 stop() 和 announce_now() 都能及时生效
                    let deadline = Instant::now() + BEACON_EVERY;
                    while Instant::now() < deadline && !stop.load(Ordering::Relaxed) {
                        if pulse.swap(false, Ordering::Relaxed) {
                            break; // 提前结束这一轮 → 回到顶部立刻再发一次
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }));
        }

        // ── 回收 ──────────────────────────────────────────────────────────
        {
            let stop = stop.clone();
            let peers = peers.clone();
            handles.push(thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(500));
                    let dead: Vec<String> = {
                        let mut table = peers.lock().unwrap();
                        let now = Instant::now();
                        let dead: Vec<String> = table
                            .iter()
                            .filter(|(_, (_, seen))| now.duration_since(*seen) > PEER_TIMEOUT)
                            .map(|(id, _)| id.clone())
                            .collect();
                        for id in &dead {
                            table.remove(id);
                        }
                        dead
                    };
                    for id in dead {
                        sink(DiscoverEvent::Gone(id));
                    }
                }
            }));
        }

        Ok(Self {
            stop,
            pulse,
            peers,
            beacon,
            handles: Mutex::new(handles),
        })
    }

    /// 更新我们对外广播的自我介绍。名字/头像改了之后调它，下一个信标就带上了。
    pub fn update_beacon(&self, f: impl FnOnce(&mut Beacon)) {
        let mut b = self.beacon.lock().unwrap();
        f(&mut b);
    }

    /// 当前活着的节点（不含自己）。
    pub fn peers(&self) -> Vec<DiscoveredPeer> {
        let table = self.peers.lock().unwrap();
        let mut v: Vec<DiscoveredPeer> = table.values().map(|(p, _)| p.clone()).collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    /// 立刻再发一轮信标，不等下一个 3 秒。
    ///
    /// 用在两个地方：刚启动时（让已经在等的人马上看到你），以及用户点了刷新。
    /// 「点了没反应，3 秒后才出来」是最容易被当成「坏了」的体验。
    pub fn announce_now(&self) {
        self.pulse.store(true, Ordering::Relaxed);
    }

    /// 停止并等所有线程退出。幂等。
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        let mut hs = self.handles.lock().unwrap();
        for h in hs.drain(..) {
            let _ = h.join();
        }
    }
}

impl Drop for Discoverer {
    fn drop(&mut self) {
        self.stop();
    }
}

// ── 内部工具 ──────────────────────────────────────────────────────────────

/// 绑一个「可以和同机其它实例共享」的 UDP 端口。
///
/// `SO_REUSEADDR` 是 Windows 上两个进程绑同一端口的前提；没有它第二个实例直接
/// `WSAEADDRINUSE`，同机双开（自测，或者一台机器两个人用）就完全没法工作。
fn bind_shared(port: u16) -> std::io::Result<UdpSocket> {
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    sock.set_reuse_address(true)?;
    let addr: SocketAddr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));
    sock.bind(&addr.into())?;
    // 加入组播组。用 INADDR_ANY 当接口，等价于「所有网卡都收」——
    // 有线+无线同时活着的机器上这一点是必须的。
    if let Err(e) = sock.join_multicast_v4(&GROUP, &Ipv4Addr::UNSPECIFIED) {
        log::warn!("发现：加入组播组失败（{e}），将只靠子网广播");
    }
    Ok(sock.into())
}

/// 信标要发到哪几个地址。
fn beacon_targets(port: u16) -> Vec<SocketAddr> {
    let mut v = vec![SocketAddr::from((GROUP, port))];
    // 受限广播：一定会从「主网卡」出去
    v.push(SocketAddr::from((Ipv4Addr::BROADCAST, port)));
    // 定向子网广播：组播被 AP 丢掉、而受限广播又被某些协议栈只发一张网卡时兜底
    if let Some(b) = subnet_broadcast() {
        v.push(SocketAddr::from((b, port)));
    }
    v.dedup();
    v
}

/// 猜本机所在子网的广播地址。
///
/// 手法是「连一个不会真的发包的外部地址，然后问内核我用了哪个源 IP」——
/// 零依赖拿到主网卡地址，不用遍历网卡列表。假设 /24，对家用与企业网足够；
/// 猜错也只是少一个兜底目标，组播照旧在工作。
fn subnet_broadcast() -> Option<Ipv4Addr> {
    let probe = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    probe.connect((Ipv4Addr::new(203, 0, 113, 1), 9)).ok()?; // TEST-NET-3，只是问路
    let ip = match probe.local_addr().ok()? {
        SocketAddr::V4(v4) => *v4.ip(),
        SocketAddr::V6(_) => return None,
    };
    if ip.is_unspecified() || ip.is_loopback() {
        return None;
    }
    let o = ip.octets();
    Some(Ipv4Addr::new(o[0], o[1], o[2], 255))
}

fn build_beacon(b: &Beacon) -> serde_json::Result<Vec<u8>> {
    serde_json::to_vec(&serde_json::json!({
        "b": MAGIC,
        "id": b.id,
        "port": b.port,
        "info": b.info,
    }))
}

/// 解析一封来信标。
///
/// 任何不合规的输入都返回 `None` —— 发现端口是公开的，别的东西也会往这里发包，
/// 解析器必须把「这不是我们的包」当成常态而不是异常。
fn parse_beacon(buf: &[u8], ip: Ipv4Addr) -> Option<DiscoveredPeer> {
    let v: serde_json::Value = serde_json::from_slice(buf).ok()?;
    if v.get("b").and_then(|x| x.as_u64()) != Some(MAGIC) {
        return None;
    }
    let id = v.get("id")?.as_str()?.to_string();
    if id.is_empty() || id.len() > 64 {
        return None;
    }
    let port = v.get("port")?.as_u64()?;
    if port == 0 || port > 65535 {
        return None;
    }
    Some(DiscoveredPeer {
        id,
        port: port as u16,
        ip,
        info: v.get("info").cloned().unwrap_or(serde_json::Value::Null),
    })
}

#[cfg(test)]
#[allow(non_snake_case)] // 自测名写成中文：读起来是一句人话，比拼音或英文缩写强
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn beacon(id: &str, port: u16) -> Beacon {
        Beacon {
            id: id.to_string(),
            port,
            info: serde_json::json!({ "name": id }),
        }
    }

    /// 绑一个空闲的 UDP 端口，避免测试之间抢端口。
    fn free_udp_port() -> u16 {
        let s = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        s.local_addr().unwrap().port()
    }

    #[test]
    fn 能解析自己的信标() {
        let b = beacon("AAAA", 47800);
        let raw = build_beacon(&b).unwrap();
        let p = parse_beacon(&raw, Ipv4Addr::new(192, 168, 1, 5)).unwrap();
        assert_eq!(p.id, "AAAA");
        assert_eq!(p.port, 47800);
        // IP 来自包的来源，不是信标自称的
        assert_eq!(p.ip, Ipv4Addr::new(192, 168, 1, 5));
        assert_eq!(p.addr().to_string(), "192.168.1.5:47800");
    }

    #[test]
    fn 垃圾输入一律拒绝而不是崩() {
        let ip = Ipv4Addr::LOCALHOST;
        assert!(parse_beacon(b"", ip).is_none());
        assert!(parse_beacon(b"not json", ip).is_none());
        assert!(parse_beacon(b"{}", ip).is_none());
        assert!(parse_beacon(b"[1,2,3]", ip).is_none());
        assert!(parse_beacon(b"null", ip).is_none());
        // 版本号不对
        assert!(parse_beacon(br#"{"b":1,"id":"A","port":1}"#, ip).is_none());
        // 有 magic 但缺字段
        assert!(parse_beacon(format!(r#"{{"b":{MAGIC}}}"#).as_bytes(), ip).is_none());
        assert!(parse_beacon(format!(r#"{{"b":{MAGIC},"id":"A"}}"#).as_bytes(), ip).is_none());
    }

    #[test]
    fn 非法id与端口被拒() {
        let ip = Ipv4Addr::LOCALHOST;
        let mk = |id: &str, port: i64| format!(r#"{{"b":{MAGIC},"id":"{id}","port":{port}}}"#);
        assert!(parse_beacon(mk("", 1).as_bytes(), ip).is_none(), "空 id");
        assert!(parse_beacon(mk("A", 0).as_bytes(), ip).is_none(), "端口 0");
        assert!(parse_beacon(mk("A", 65536).as_bytes(), ip).is_none(), "端口越界");
        assert!(parse_beacon(mk("A", -1).as_bytes(), ip).is_none(), "负端口");
        let long = "x".repeat(65);
        assert!(parse_beacon(mk(&long, 1).as_bytes(), ip).is_none(), "id 过长");
        assert!(parse_beacon(mk(&"x".repeat(64), 1).as_bytes(), ip).is_some(), "64 位应该通过");
    }

    #[test]
    fn 广播目标至少包含组播和受限广播() {
        let t = beacon_targets(47800);
        assert!(t.contains(&SocketAddr::from((GROUP, 47800))));
        assert!(t.contains(&SocketAddr::from((Ipv4Addr::BROADCAST, 47800))));
        let mut sorted = t.clone();
        sorted.dedup();
        assert_eq!(sorted.len(), t.len(), "不该有重复目标：{t:?}");
    }

    /// 收包路径 + 解析 + 去重 + 事件出口，全部走真实 socket。
    ///
    /// 直接单播到发现端口，而不是真的发组播：组播在 CI/容器里能不能回环是环境问题，
    /// 而这里要证明的是「包进来之后处理得对不对」，那一段不该依赖网络环境。
    #[test]
    fn 收到信标会报一次Found之后就安静() {
        let port = free_udp_port();
        let (tx, rx) = mpsc::channel();
        let sink: Sink = Arc::new(move |e| {
            let _ = tx.send(e);
        });
        let d = Discoverer::start(port, beacon("SELF", 1), sink).unwrap();

        let wire = build_beacon(&beacon("OTHER", 47801)).unwrap();
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        // 连发三封同样的信标：只应该报一次 Found
        for _ in 0..3 {
            sender
                .send_to(&wire, (Ipv4Addr::LOCALHOST, port))
                .unwrap();
            thread::sleep(Duration::from_millis(60));
        }

        let first = rx.recv_timeout(Duration::from_secs(3)).expect("应该收到 Found");
        match &first {
            DiscoverEvent::Found(p) => {
                assert_eq!(p.id, "OTHER");
                assert_eq!(p.port, 47801);
                assert_eq!(p.ip, Ipv4Addr::LOCALHOST);
            }
            other => panic!("第一个事件应该是 Found，实际 {other:?}"),
        }

        // 重复信标不该再报
        assert!(
            rx.recv_timeout(Duration::from_millis(400)).is_err(),
            "同一份信标重复到达不应该重复报 Found"
        );

        // peers() 里能查到
        let list = d.peers();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "OTHER");
        d.stop();
    }

    #[test]
    fn 自己的信标被忽略() {
        let port = free_udp_port();
        let (tx, rx) = mpsc::channel();
        let sink: Sink = Arc::new(move |e| {
            let _ = tx.send(e);
        });
        let d = Discoverer::start(port, beacon("ME", 1), sink).unwrap();
        let wire = build_beacon(&beacon("ME", 47801)).unwrap();
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        sender.send_to(&wire, (Ipv4Addr::LOCALHOST, port)).unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(500)).is_err(),
            "自己的信标不应该被上报"
        );
        assert!(d.peers().is_empty());
        d.stop();
    }

    #[test]
    fn 自我介绍能就地改掉() {
        let port = free_udp_port();
        let d = Discoverer::start(
            port,
            beacon("ME", 1),
            Arc::new(|_| {}) as Sink,
        )
        .unwrap();
        d.update_beacon(|b| {
            b.info = serde_json::json!({ "name": "新名字" });
        });
        assert_eq!(
            d.beacon.lock().unwrap().info["name"],
            serde_json::Value::String("新名字".into())
        );
        d.stop();
    }

    #[test]
    fn stop是幂等的() {
        let port = free_udp_port();
        let d = Discoverer::start(port, beacon("ME", 1), Arc::new(|_| {}) as Sink).unwrap();
        d.stop();
        d.stop(); // 第二次不该 panic 也不该卡住
    }

    /// 从事件流里等一个指定 id 的 `Found`。
    fn wait_found(rx: &mpsc::Receiver<DiscoverEvent>, want: &str, budget: Duration) -> bool {
        let deadline = Instant::now() + budget;
        while Instant::now() < deadline {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(DiscoverEvent::Found(p)) if p.id == want => return true,
                Ok(_) => {}
                Err(_) => return false,
            }
        }
        false
    }

    /// 两个发现器（模拟两台机器）绑同一个端口，靠**真实组播**互相看见。
    ///
    /// 上面那条 `收到信标会报一次Found之后就安静` 走的是单播直投，证明的是
    /// 「包收进来之后处理得对不对」；这一条才回答验收里那句「两台机器打开就能
    /// 互相发现」。它走的是真组播组、真 `SO_REUSEADDR` 共享端口、真回环 ——
    /// 单播直投是证明不了的：`join_multicast_v4` 失败、TTL 配错、或者信标发到
    /// 了错误的接口，三种都会让单播测试照过而实际谁也看不见谁。
    ///
    /// 组播回环在极少数环境下是关的（部分虚拟网卡、某些容器网络）。真碰上就
    /// 如实失败，不要为了让它变绿而改成单播 —— 那条路径已经有人测了。
    #[test]
    fn 两台机器靠真实组播互相看见() {
        let port = free_udp_port();
        let (txa, rxa) = mpsc::channel();
        let (txb, rxb) = mpsc::channel();
        let sink = |tx: mpsc::Sender<DiscoverEvent>| -> Sink {
            Arc::new(move |e| {
                let _ = tx.send(e);
            })
        };

        let a = Discoverer::start(port, beacon("AAAA", 47801), sink(txa)).unwrap();
        let b = Discoverer::start(port, beacon("BBBB", 47802), sink(txb)).unwrap();

        // 两边都立刻发一轮，不等 3 秒节拍 —— 这同时验证了 announce_now 真的有效
        a.announce_now();
        b.announce_now();

        let budget = Duration::from_secs(8);
        let a_sees_b = wait_found(&rxa, "BBBB", budget);
        let b_sees_a = wait_found(&rxb, "AAAA", budget);

        // peers() 是不依赖事件出口的第二条证据
        let a_list = a.peers();
        let b_list = b.peers();

        a.stop();
        b.stop();

        assert!(a_sees_b, "A 没看见 B。peers={a_list:?}");
        assert!(b_sees_a, "B 没看见 A。peers={b_list:?}");
        assert_eq!(a_list.len(), 1);
        assert_eq!(a_list[0].id, "BBBB");
        assert_eq!(a_list[0].port, 47802);
        assert_eq!(b_list[0].id, "AAAA");
        assert_eq!(b_list[0].port, 47801);

        // IP 必须来自 UDP 包的来源地址，而不是信标里自称的（信标里根本没有 IP 字段，
        // 见 build_beacon；`能解析自己的信标` 在单元层守着这条）。
        //
        // 这里**不**断言回环，也**不**断言两边看到的是同一个地址 —— 实测下来
        // 两个方向可以走不同的网卡：一台开发机常有多个 IPv4 地址（以太网、WLAN、
        // 虚拟机网卡、VPN 隧道、蓝牙……），
        // 组播从哪个接口出去、收回来时栈报哪个地址，由路由表决定，不由我们决定。
        // 能断言的是「报回来的是一个本机真实存在的局域网地址」，这就够了。
        for (who, ip) in [("A 看到的 B", a_list[0].ip), ("B 看到的 A", b_list[0].ip)] {
            assert!(!ip.is_unspecified(), "{who} 的来源地址不该是 0.0.0.0");
            assert!(
                ip.is_loopback() || ip.is_private() || ip.is_link_local(),
                "{who} 的来源地址 {ip} 不像一个局域网地址"
            );
        }
    }
}
