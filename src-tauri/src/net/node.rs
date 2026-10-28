//! 节点中枢：把发现、拨号、去重、读线程和断线回收拼成一个东西。
//!
//! 对外只有几个动作：起、停、发给某人、发给所有人、看有谁、改自我介绍。
//! 其余全是内部状态机。
//!
//! 一条贯穿始终的纪律：**「判断该不该留」和「放进表里」必须在同一把锁里完成**。
//! 双方同时拨号、读线程同时报断开、发现线程同时报上线 —— 这三件事天然并发。
//! 用「先查有没有、再插进去」的写法，一定会在某一刻让两条链路同时活着，
//! 表现是消息发两遍、断开时机错乱，而且复现不了。

use crate::net::discover::{DiscoveredPeer, DiscoverEvent, Discoverer, Sink as DiscoverSink};
use crate::net::frames::read_frame;
use crate::net::link::{handshake, is_dialable, Link};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufReader};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// 连不上的判定要快：局域网里连不上就是连不上。等太久只是让人以为程序卡了。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// 「等对方来拨」的时限，超时就自己也拨一次。
///
/// 为什么需要它：组播在某些网络上只往一个方向通（AP 客户端隔离、多网卡选错接口），
/// 于是编号小的那台看见了编号大的、编号大的却没看见编号小的。如果只有编号小的
/// 负责拨号，这一对就永远连不上 —— 而统计上「跟别人都正常，就他俩不行」
/// 是最让人抓狂的故障。超时后编号大的也试一次，由对称去重规则收尾。
const FALLBACK_DIAL_AFTER: Duration = Duration::from_secs(6);

/// 同时最多跑多少个入站握手。
///
/// 每条入站连接一个线程，而线程上限就是攻击面：局域网上任何进程都能连这个
/// 端口，连上就 spawn 一个线程 —— 对他几乎零成本，对我们是一个线程栈。
/// 握手超时（`link.rs` 的 `HANDSHAKE_TIMEOUT`）只保证它们**会**退出，
/// 不保证同时没那么多；攒够几千条就够把进程拖垮。
///
/// 超上限**直接丢掉这条连接**，不排队：同屏真人对端不会超过几十个，
/// 撞上限的正常情况是「一台机器同时被很多对端拨」，那时排不排队都一样，
/// 但队列会变成一个可控的内存增长点。
const MAX_INBOUND_HANDSHAKES: usize = 64;

#[derive(Clone, Debug)]
pub struct NodeConfig {
    /// 本机设备编号（十六进制大写，和界面上的 UID 同一个）
    pub self_id: String,
    /// 对外广播的自我介绍（名字/头像/key/指纹）。Rust 不解释内容。
    pub info: serde_json::Value,
    /// TCP 数据端口。传 0 = 让系统挑一个（自测用），实际端口用 `tcp_port()` 读回。
    pub tcp_port: u16,
    /// UDP 发现端口
    pub udp_port: u16,
}

/// 节点往外报的事件。前端只需要这一个入口。
///
/// 用 `kind` 做标签而不是默认的 externally-tagged：TS 侧写
/// `switch (e.kind)` 比 `switch (Object.keys(e)[0])` 不容易写错。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NodeEvent {
    /// 局域网上看到某人（可能还没连上）
    Discovered(DiscoveredPeer),
    /// 某人超过 12 秒没再出现
    Lost(String),
    /// 和某人建立了直连
    Linked {
        peer_id: String,
        addr: String,
        info: serde_json::Value,
    },
    /// 和某人断开了。reason 是给人看的中文短句。
    Unlinked { peer_id: String, reason: String },
    /// 收到一帧。内容 Rust 不解释，原样给前端。
    Frame { from: String, data: Vec<u8> },
}

pub type Sink = Arc<dyn Fn(NodeEvent) + Send + Sync>;

/// 给界面看的一个人。
#[derive(Clone, Debug, serde::Serialize)]
pub struct PeerInfo {
    pub id: String,
    pub addr: Option<String>,
    pub connected: bool,
    /// 自我介绍（名字/头像/key/指纹）。握手带来的比信标新。
    pub info: serde_json::Value,
}

pub struct Node {
    self_id: String,
    info: Mutex<serde_json::Value>,
    listen_port: u16,
    discoverer: Arc<Discoverer>,
    links: Arc<Mutex<HashMap<String, Arc<Link>>>>,
    stop: Arc<AtomicBool>,
    sink: Sink,
    handles: Mutex<Vec<JoinHandle<()>>>,
}

impl Node {
    pub fn start(cfg: NodeConfig, sink: Sink) -> io::Result<Self> {
        // TCP 端口先试约定的那个，被占了就退到系统分配。
        //
        // 为什么不能「被占了就直接失败」（原来就是这样，实测踩到了）：Windows 上
        // `TcpListener::bind` 第二次绑同一个端口会回 `os error 10048`，于是同一台
        // 机器上开第二个实例的那个**整个起不来** —— 界面停在「未启动」，没有任何
        // 提示指向端口。而端口根本不是不可替代的：真正的地址是**发现信标里那个
        // `port` 字段**（`discover.rs` 的 `Beacon`），对端从来不需要猜我们绑在哪。
        // 所以约定端口只是「大家都能猜到时的方便」，猜不到也不影响任何人。
        //
        // 退让的代价只有一个：这台机器上第一个实例之外的那些不再是 47800。
        // 那是它们自己该知道的事（它们自己播的就是真实端口）。
        let listener = match TcpListener::bind((Ipv4Addr::UNSPECIFIED, cfg.tcp_port)) {
            Ok(l) => l,
            Err(e) if e.kind() == io::ErrorKind::AddrInUse && cfg.tcp_port != 0 => {
                TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))?
            }
            Err(e) => return Err(e),
        };
        let listen_port = listener.local_addr()?.port();

        let stop = Arc::new(AtomicBool::new(false));
        let links: Arc<Mutex<HashMap<String, Arc<Link>>>> = Arc::new(Mutex::new(HashMap::new()));
        let dialing: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let first_seen: Arc<Mutex<HashMap<String, Instant>>> = Arc::new(Mutex::new(HashMap::new()));

        let discoverer = Arc::new(Discoverer::start(
            cfg.udp_port,
            crate::net::discover::Beacon {
                id: cfg.self_id.clone(),
                port: listen_port,
                info: cfg.info.clone(),
            },
            {
                let sink = sink.clone();
                let links = links.clone();
                let dialing = dialing.clone();
                let first_seen = first_seen.clone();
                let self_id = cfg.self_id.clone();
                let info = cfg.info.clone();
                let stop = stop.clone();
                Arc::new(move |e: DiscoverEvent| match e {
                    DiscoverEvent::Found(p) => {
                        first_seen
                            .lock()
                            .unwrap()
                            .entry(p.id.clone())
                            .or_insert_with(Instant::now);
                        sink(NodeEvent::Discovered(p.clone()));
                        // 编号小的主动拨号；编号大的先等，超时后由兜底线程补
                        if self_id < p.id && is_dialable(IpAddr::V4(p.ip)) {
                            let sink = sink.clone();
                            let links = links.clone();
                            let dialing = dialing.clone();
                            let self_id = self_id.clone();
                            let info = info.clone();
                            let addr = p.addr();
                            let want = p.id.clone();
                            let stop = stop.clone();
                            thread::spawn(move || {
                                if stop.load(Ordering::Relaxed) {
                                    return;
                                }
                                dial_into(addr, &want, &self_id, &info, &links, &dialing, &sink);
                            });
                        }
                    }
                    DiscoverEvent::Gone(id) => {
                        first_seen.lock().unwrap().remove(&id);
                        sink(NodeEvent::Lost(id.clone()));
                        // 人不见了就把链路也收掉。TCP 要到很久以后才会因为对端
                        // 消失而报错，靠它的话联系人列表会一直显示「在线」。
                        let dead = links.lock().unwrap().remove(&id);
                        if let Some(l) = dead {
                            l.close();
                            sink(NodeEvent::Unlinked {
                                peer_id: id,
                                reason: "对方从局域网上消失了".into(),
                            });
                        }
                    }
                }) as DiscoverSink
            },
        )?);

        let mut handles = Vec::new();

        // ── 接听线程 ──────────────────────────────────────────────────────
        {
            let self_id = cfg.self_id.clone();
            let info = cfg.info.clone();
            let sink = sink.clone();
            let links = links.clone();
            let stop = stop.clone();
            let handshaking = Arc::new(AtomicUsize::new(0));
            handles.push(thread::spawn(move || {
                for stream in listener.incoming() {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let stream = match stream {
                        Ok(s) => s,
                        Err(e) => {
                            log::debug!("接听失败：{e}");
                            continue;
                        }
                    };
                    if handshaking.load(Ordering::Relaxed) >= MAX_INBOUND_HANDSHAKES {
                        log::debug!("入站握手已经排了 {MAX_INBOUND_HANDSHAKES} 个，丢掉这条连接");
                        continue;
                    }
                    let self_id = self_id.clone();
                    let info = info.clone();
                    let sink = sink.clone();
                    let links = links.clone();
                    let handshaking = handshaking.clone();
                    // 每条入站连接一个线程：握手可能被恶意的对端拖住，
                    // 放在接听线程里会让整个节点不再接受任何连接。
                    // 计数在**派线程之前**加，派完立刻减 —— 它数的是「正在
                    // 握手的连接数」，不是「正在跑的线程数」，所以 `adopt`
                    // 里干活的那部分不占名额。
                    handshaking.fetch_add(1, Ordering::Relaxed);
                    thread::spawn(move || {
                        let result = handshake(stream, &self_id, &info);
                        handshaking.fetch_sub(1, Ordering::Relaxed);
                        match result {
                            Ok(h) => {
                                let (link, reader) = h.split(&self_id, false);
                                adopt(link, reader, &links, &sink);
                            }
                            Err(e) => log::debug!("入站握手失败：{e}"),
                        }
                    });
                }
            }));
        }

        // ── 兜底拨号线程 ──────────────────────────────────────────────────
        {
            let self_id = cfg.self_id.clone();
            let info = cfg.info.clone();
            let links = links.clone();
            let dialing = dialing.clone();
            let first_seen = first_seen.clone();
            let discoverer = discoverer.clone();
            let sink = sink.clone();
            let stop = stop.clone();
            handles.push(thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(1000));
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let now = Instant::now();
                    let candidates: Vec<DiscoveredPeer> = discoverer
                        .peers()
                        .into_iter()
                        .filter(|p| {
                            if p.id <= self_id {
                                return false; // 编号小的那条路已经试过了
                            }
                            if links.lock().unwrap().contains_key(&p.id) {
                                return false;
                            }
                            if dialing.lock().unwrap().contains(&p.id) {
                                return false;
                            }
                            if !is_dialable(IpAddr::V4(p.ip)) {
                                return false;
                            }
                            first_seen
                                .lock()
                                .unwrap()
                                .get(&p.id)
                                .map(|t| now.duration_since(*t) > FALLBACK_DIAL_AFTER)
                                .unwrap_or(false)
                        })
                        .collect();
                    for p in candidates {
                        let addr = p.addr();
                        let want = p.id.clone();
                        let self_id = self_id.clone();
                        let info = info.clone();
                        let links = links.clone();
                        let dialing = dialing.clone();
                        let sink = sink.clone();
                        thread::spawn(move || {
                            dial_into(addr, &want, &self_id, &info, &links, &dialing, &sink);
                        });
                    }
                }
            }));
        }

        Ok(Self {
            self_id: cfg.self_id,
            info: Mutex::new(cfg.info),
            listen_port,
            discoverer,
            links,
            stop,
            sink,
            handles: Mutex::new(handles),
        })
    }

    /// 本机实际监听的 TCP 端口（配置里传 0 时才知道真实值）
    pub fn tcp_port(&self) -> u16 {
        self.listen_port
    }

    /// 主动连一个地址。自测和「用户手填地址」都走这里。
    pub fn connect_to(&self, addr: SocketAddr) -> io::Result<()> {
        if !is_dialable(addr.ip()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{addr} 不是局域网里可以直连的地址"),
            ));
        }
        let info = self.info.lock().unwrap().clone();
        let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)?;
        let (link, reader) = handshake(stream, &self.self_id, &info)?.split(&self.self_id, true);
        adopt(link, reader, &self.links, &self.sink);
        Ok(())
    }

    /// 发给某一个人。
    ///
    /// 对方不在线就返回错误 —— **离线队列在 TS 侧**。Rust 只负责回答
    /// 「现在能不能送到」这一个事实，不做任何排队：排队策略要随界面说话
    /// （在气泡上显示「待送达」），那是前端的事。
    pub fn send(&self, peer_id: &str, payload: &[u8]) -> io::Result<()> {
        let link = self.links.lock().unwrap().get(peer_id).cloned();
        match link {
            Some(l) if !l.is_closed() => l.send(payload),
            _ => Err(io::Error::new(
                io::ErrorKind::NotConnected,
                format!("{peer_id} 当前不在线"),
            )),
        }
    }

    /// 发给所有已连接的人。返回送出去了几份。
    ///
    /// 有人发失败（刚好断开）不算整体失败 —— 广播的语义就是尽力而为，
    /// 让一个掉线的人挡住所有人的公告是更糟的选择。
    pub fn broadcast(&self, payload: &[u8]) -> usize {
        let targets: Vec<Arc<Link>> = self.links.lock().unwrap().values().cloned().collect();
        targets.iter().filter(|l| l.send(payload).is_ok()).count()
    }

    /// 界面要的完整名单：发现到的人 + 已连接状态。
    pub fn peers(&self) -> Vec<PeerInfo> {
        let links = self.links.lock().unwrap();
        let mut out: Vec<PeerInfo> = self
            .discoverer
            .peers()
            .into_iter()
            .map(|p| {
                let link = links.get(&p.id).filter(|l| !l.is_closed());
                PeerInfo {
                    id: p.id.clone(),
                    addr: Some(p.addr().to_string()),
                    connected: link.is_some(),
                    // 握手带来的自我介绍比信标新（改了名字但下一轮信标还没发）
                    info: link
                        .map(|l| l.info.clone())
                        .filter(|v| !v.is_null())
                        .unwrap_or(p.info.clone()),
                }
            })
            .collect();
        // 已连上但发现表里暂时没有的（极端时序）也要列出来，否则界面上会出现
        // 「已经能聊天，但列表里没人」
        for (id, l) in links.iter() {
            if !l.is_closed() && !out.iter().any(|p| &p.id == id) {
                out.push(PeerInfo {
                    id: id.clone(),
                    addr: Some(l.addr.to_string()),
                    connected: true,
                    info: l.info.clone(),
                });
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// 当前连着的人
    pub fn connected(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .links
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, l)| !l.is_closed())
            .map(|(id, _)| id.clone())
            .collect();
        v.sort();
        v
    }

    /// 更新对外广播的自我介绍。
    pub fn set_info(&self, info: serde_json::Value) {
        *self.info.lock().unwrap() = info.clone();
        self.discoverer.update_beacon(|b| b.info = info);
    }

    /// 立刻再广播一轮，不等下一个 3 秒周期。
    pub fn announce_now(&self) {
        self.discoverer.announce_now();
    }

    pub fn stop(&self) {
        if self.stop.swap(true, Ordering::Relaxed) {
            return; // 幂等：第二次调用直接返回，也让 Drop 里重复调用变成没事发生
        }
        // 接听线程阻塞在 `accept()` 里，它**看不到**上面那个标志位 ——
        // 只有来一条连接才会醒。所以自己连自己一次把它叫醒，否则下面 join 会永远挂住。
        // （自测里这就是「所有 node 测试全部卡死 60 秒以上」的成因。）
        let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, self.listen_port));
        // 关掉所有链路 —— 读线程都阻塞在 read 上，只有 shutdown 能把它们叫醒
        {
            let mut links = self.links.lock().unwrap();
            for (_, l) in links.drain() {
                l.close();
            }
        }
        self.discoverer.stop();
        let mut hs = self.handles.lock().unwrap();
        for h in hs.drain(..) {
            let _ = h.join();
        }
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        self.stop();
    }
}

// ── 内部 ─────────────────────────────────────────────────────────────────

/// 把一个已经握好手的链路放进表里，并起读线程。
///
/// 去重与插入在同一把锁里完成（见文件头）。被淘汰的那条在**锁外**关闭：
/// 在锁里关会持有锁去做一次系统调用，而 `close` 可能触发对端立刻断开、
/// 反过来又要拿同一把锁。
fn adopt(
    link: Link,
    reader: BufReader<TcpStream>,
    links: &Arc<Mutex<HashMap<String, Arc<Link>>>>,
    sink: &Sink,
) {
    let peer_id = link.peer_id.clone();
    let addr = link.addr.to_string();
    let info = link.info.clone();

    let (chosen, replaced) = {
        let mut table = links.lock().unwrap();
        match table.get(&peer_id) {
            // 已经有一条活着的
            Some(old) if !old.is_closed() => {
                if link.should_keep() && !old.should_keep() {
                    let new = Arc::new(link);
                    let old = table.insert(peer_id.clone(), new.clone());
                    (new, old)
                } else {
                    // 新的这条让位。**不**发 Linked（对方那条本来就是活的）。
                    drop(table);
                    link.close();
                    return;
                }
            }
            // 没有，或者旧的那条已经死了 → 用新的
            _ => {
                let new = Arc::new(link);
                table.insert(peer_id.clone(), new.clone());
                (new, None)
            }
        }
    };

    if let Some(old) = replaced {
        old.close();
        log::debug!("换用更该留的那条链路：{peer_id}");
    }

    sink(NodeEvent::Linked {
        peer_id: peer_id.clone(),
        addr,
        info,
    });

    let links = links.clone();
    let sink = sink.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let reason = loop {
            match read_frame(&mut reader) {
                Ok(Some(data)) => sink(NodeEvent::Frame {
                    from: peer_id.clone(),
                    data,
                }),
                Ok(None) => break "对方关闭了连接".to_string(),
                Err(e) => break format!("读取失败：{e}"),
            }
        };

        // 只有「表里现在还是我这条」时才移除并上报。
        // 否则说明我已经被替换掉了 —— 那时候报 Unlinked 会把新链路也一起标记成断开。
        let removed = {
            let mut table = links.lock().unwrap();
            match table.get(&peer_id) {
                Some(cur) if Arc::ptr_eq(cur, &chosen) => {
                    table.remove(&peer_id);
                    true
                }
                _ => false,
            }
        };
        chosen.close();
        if removed {
            sink(NodeEvent::Unlinked { peer_id, reason });
        }
    });
}

fn dial_into(
    addr: SocketAddr,
    want: &str,
    self_id: &str,
    info: &serde_json::Value,
    links: &Arc<Mutex<HashMap<String, Arc<Link>>>>,
    dialing: &Arc<Mutex<HashSet<String>>>,
    sink: &Sink,
) {
    {
        let mut d = dialing.lock().unwrap();
        if !d.insert(want.to_string()) {
            return; // 已经有人在拨了
        }
    }

    let outcome = (|| -> io::Result<(Link, BufReader<TcpStream>)> {
        let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)?;
        let h = handshake(stream, self_id, info)?;
        if h.peer_id != want {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{addr} 上住的是 {}，不是 {}", h.peer_id, want),
            ));
        }
        Ok(h.split(self_id, true))
    })();

    dialing.lock().unwrap().remove(want);
    match outcome {
        Ok((link, reader)) => adopt(link, reader, links, sink),
        Err(e) => log::debug!("拨号 {addr} 失败：{e}"),
    }
}

#[cfg(test)]
#[allow(non_snake_case)] // 自测名写成中文：读起来是一句人话，比拼音或英文缩写强
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    use std::sync::mpsc::{channel, Receiver};

    fn free_udp_port() -> u16 {
        std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn cfg(id: &str, tcp: u16, udp: u16) -> NodeConfig {
        NodeConfig {
            self_id: id.into(),
            info: serde_json::json!({ "name": id }),
            tcp_port: tcp,
            udp_port: udp,
        }
    }

    fn spawn(id: &str, udp: u16) -> (Node, Receiver<NodeEvent>) {
        let (tx, rx) = channel();
        let n = Node::start(cfg(id, 0, udp), Arc::new(move |e| {
            let _ = tx.send(e);
        }))
        .unwrap();
        (n, rx)
    }

    /// 等到某个事件出现；超时就失败并把这段期间收到的都打出来。
    fn wait_for<F: Fn(&NodeEvent) -> bool>(rx: &Receiver<NodeEvent>, what: &str, f: F) -> NodeEvent {
        let deadline = Instant::now() + Duration::from_secs(6);
        let mut seen = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                panic!("等不到「{what}」，期间收到：{seen:#?}");
            }
            match rx.recv_timeout(left) {
                Ok(e) => {
                    if f(&e) {
                        return e;
                    }
                    seen.push(e);
                }
                Err(_) => panic!("等不到「{what}」，期间收到：{seen:#?}"),
            }
        }
    }

    #[test]
    fn 两个节点能互连并互发一帧() {
        let (a, rxa) = spawn("AAAA000000000001", free_udp_port());
        let (b, rxb) = spawn("BBBB000000000002", free_udp_port());

        a.connect_to(SocketAddr::from((Ipv4Addr::LOCALHOST, b.tcp_port())))
            .unwrap();

        // 两边都必须报 Linked：发起方和接听方走的是两条不同的代码路径
        let ea = wait_for(&rxa, "A 侧 Linked", |e| matches!(e, NodeEvent::Linked { .. }));
        let eb = wait_for(&rxb, "B 侧 Linked", |e| matches!(e, NodeEvent::Linked { .. }));
        match (ea, eb) {
            (
                NodeEvent::Linked { peer_id: pa, .. },
                NodeEvent::Linked { peer_id: pb, .. },
            ) => {
                assert_eq!(pa, "BBBB000000000002");
                assert_eq!(pb, "AAAA000000000001");
            }
            _ => unreachable!(),
        }

        assert_eq!(a.connected(), vec!["BBBB000000000002"]);
        assert_eq!(b.connected(), vec!["AAAA000000000001"]);

        // 内容原样穿过，不做任何解释
        let payload = br#"{"t":"msg","body":"\u4f60\u597d"}"#;
        a.send("BBBB000000000002", payload).unwrap();
        match wait_for(&rxb, "B 收到帧", |e| matches!(e, NodeEvent::Frame { .. })) {
            NodeEvent::Frame { from, data } => {
                assert_eq!(from, "AAAA000000000001");
                assert_eq!(data, payload.to_vec());
            }
            _ => unreachable!(),
        }

        // 反向也要通
        b.send("AAAA000000000001", b"pong").unwrap();
        match wait_for(&rxa, "A 收到帧", |e| matches!(e, NodeEvent::Frame { .. })) {
            NodeEvent::Frame { from, data } => {
                assert_eq!(from, "BBBB000000000002");
                assert_eq!(data, b"pong".to_vec());
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn 发给不在线的人是个明确的错误而不是静默丢弃() {
        let (a, _rxa) = spawn("AAAA000000000001", free_udp_port());
        let err = a.send("NOSUCHPEER000000", b"hi").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotConnected);
        assert!(err.to_string().contains("不在线"), "{}", err);
    }

    #[test]
    fn 广播会送到所有已连接的人() {
        let (a, _rxa) = spawn("AAAA000000000001", free_udp_port());
        let (b, rxb) = spawn("BBBB000000000002", free_udp_port());
        let (c, rxc) = spawn("CCCC000000000003", free_udp_port());

        a.connect_to(SocketAddr::from((Ipv4Addr::LOCALHOST, b.tcp_port())))
            .unwrap();
        a.connect_to(SocketAddr::from((Ipv4Addr::LOCALHOST, c.tcp_port())))
            .unwrap();
        wait_for(&rxb, "B Linked", |e| matches!(e, NodeEvent::Linked { .. }));
        wait_for(&rxc, "C Linked", |e| matches!(e, NodeEvent::Linked { .. }));

        assert_eq!(a.broadcast(br#"{"t":"notice"}"#), 2);
        for (rx, who) in [(&rxb, "B"), (&rxc, "C")] {
            match wait_for(rx, &format!("{who} 收到广播"), |e| matches!(e, NodeEvent::Frame { .. })) {
                NodeEvent::Frame { data, .. } => assert_eq!(data, br#"{"t":"notice"}"#.to_vec()),
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn 对端关闭后本端会收到Unlinked并被摘出名单() {
        let (a, rxa) = spawn("AAAA000000000001", free_udp_port());
        let (b, rxb) = spawn("BBBB000000000002", free_udp_port());
        a.connect_to(SocketAddr::from((Ipv4Addr::LOCALHOST, b.tcp_port())))
            .unwrap();
        wait_for(&rxa, "A Linked", |e| matches!(e, NodeEvent::Linked { .. }));
        wait_for(&rxb, "B Linked", |e| matches!(e, NodeEvent::Linked { .. }));

        b.stop();

        match wait_for(&rxa, "A Unlinked", |e| matches!(e, NodeEvent::Unlinked { .. })) {
            NodeEvent::Unlinked { peer_id, reason } => {
                assert_eq!(peer_id, "BBBB000000000002");
                assert!(!reason.is_empty(), "断开原因不能是空字符串");
            }
            _ => unreachable!(),
        }
        assert!(a.connected().is_empty(), "断开后不该还留在连接表里");
    }

    #[test]
    fn 连一个非BAKER的服务会被当成失败而不是污染连接表() {
        // 一台「别人的服务器」：接受连接但不说话
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for s in l.incoming() {
                // 收到就立刻关掉，模拟「这不是 BAKER」
                drop(s);
            }
        });

        let (a, _rxa) = spawn("AAAA000000000001", free_udp_port());
        let r = a.connect_to(SocketAddr::from((Ipv4Addr::LOCALHOST, port)));
        assert!(r.is_err(), "对面不是 BAKER，不该报告成功");
        assert!(a.connected().is_empty(), "失败的连接不能留在表里");
    }

    #[test]
    fn 黑洞地址不会把节点卡住() {
        let (a, _rxa) = spawn("AAAA000000000001", free_udp_port());
        // 192.0.2.0/24 是 TEST-NET-1，保证不可达。连接会一直超时到 CONNECT_TIMEOUT。
        let t = Instant::now();
        let r = a.connect_to("192.0.2.1:47800".parse().unwrap());
        assert!(r.is_err());
        assert!(
            t.elapsed() < CONNECT_TIMEOUT + Duration::from_secs(2),
            "应该在超时窗口内失败，实际用了 {:?}",
            t.elapsed()
        );
        // 关键：失败之后这个节点还能正常干活
        let (b, rxb) = spawn("BBBB000000000002", free_udp_port());
        a.connect_to(SocketAddr::from((Ipv4Addr::LOCALHOST, b.tcp_port())))
            .unwrap();
        wait_for(&rxb, "B Linked", |e| matches!(e, NodeEvent::Linked { .. }));
    }

    #[test]
    fn 同一个地址连两次不会产生两条链路() {
        let (a, rxa) = spawn("AAAA000000000001", free_udp_port());
        let (b, rxb) = spawn("BBBB000000000002", free_udp_port());
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, b.tcp_port()));

        a.connect_to(addr).unwrap();
        a.connect_to(addr).unwrap();

        wait_for(&rxa, "A Linked", |e| matches!(e, NodeEvent::Linked { .. }));
        // 给第二条一点时间被去重掉
        thread::sleep(Duration::from_millis(300));

        assert_eq!(a.connected(), vec!["BBBB000000000002"], "同一个人只该有一条链路");
        assert_eq!(b.connected(), vec!["AAAA000000000001"], "B 侧同理");

        // 而且消息不会发两遍
        a.send("BBBB000000000002", b"only-once").unwrap();
        wait_for(&rxb, "B 收到帧", |e| matches!(e, NodeEvent::Frame { .. }));
        assert!(
            rxb.recv_timeout(Duration::from_millis(300)).is_err(),
            "重复链路没被去掉的话这里会收到第二份"
        );
    }

    #[test]
    fn 名单里带上对方的自我介绍() {
        let (a, rxa) = spawn("AAAA000000000001", free_udp_port());
        let (b, _rxb) = spawn("BBBB000000000002", free_udp_port());
        a.connect_to(SocketAddr::from((Ipv4Addr::LOCALHOST, b.tcp_port())))
            .unwrap();
        wait_for(&rxa, "A Linked", |e| matches!(e, NodeEvent::Linked { .. }));

        let list = a.peers();
        let p = list.iter().find(|p| p.id == "BBBB000000000002").expect("名单里应该有 B");
        assert!(p.connected);
        assert_eq!(p.info["name"], serde_json::Value::String("BBBB000000000002".into()));
    }

    #[test]
    fn stop是幂等的() {
        let (a, _rxa) = spawn("AAAA000000000001", free_udp_port());
        a.stop();
        a.stop();
    }

    /// 约定端口被别人占着时，节点要**退让**而不是起不来。
    ///
    /// 这条是实测抳出来的：Windows 上双开 BAKER，第二个实例回 `os error 10048`
    /// 然后整个卡在「未启动」。当时没人看出原因 —— 界面上只有「未启动」，
    /// 而没人会想到「端口」是答案。
    #[test]
    fn 约定端口被占用时退到系统分配的端口() {
        // 占住一个端口。绑 UNSPECIFIED 才和节点真正会撞的方式一致
        // （绑 127.0.0.1 在 Windows 上未必和 0.0.0.0 冲突）。
        let squatter = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        let taken = squatter.local_addr().unwrap().port();

        let (tx, _rx) = channel();
        let n = Node::start(
            cfg("AAAA000000000001", taken, free_udp_port()),
            Arc::new(move |e| {
                let _ = tx.send(e);
            }),
        )
        .expect("端口被占用不该让节点起不来");

        assert_ne!(n.tcp_port(), taken, "被占用了就必须换一个，不能声称绑上了那个");
        assert_ne!(n.tcp_port(), 0, "端口必须是真实绑上的那个");

        // 换了端口之后功能不能缺：别人照常连得上。
        // 对端从来不需要猜端口 —— 它从发现信标里读。
        let (b, rxb) = spawn("BBBB000000000002", free_udp_port());
        b.connect_to(SocketAddr::from((Ipv4Addr::LOCALHOST, n.tcp_port())))
            .unwrap();
        wait_for(&rxb, "B 连上了退让端口上的节点", |e| {
            matches!(e, NodeEvent::Linked { .. })
        });
    }

    /// 同一台机器上两个节点可以共用同一个 UDP 发现端口。
    ///
    /// 这是「同机双开」的另一半（TCP 那半见上一条）。少了 `SO_REUSEADDR`，
    /// 第二个实例的 UDP 绑定就会 `WSAEADDRINUSE`，双开依然不可用。
    #[test]
    fn 两个节点能共用同一个UDP发现端口() {
        let udp = free_udp_port();
        let (a, _rxa) = spawn("AAAA000000000001", udp);
        let (b, _rxb) = spawn("BBBB000000000002", udp);
        // 两个都起来了就是结论；UDP 收不到信标只会让它们发现不了对方，
        // 那是网络环境的事，不是绑定的错。
        assert_ne!(a.tcp_port(), b.tcp_port(), "TCP 端口仍然各用各的");
    }
}
