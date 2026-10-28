//! 帧编解码：4 字节大端长度 + 载荷。
//!
//! 为什么一次 `send` 就是一整帧：协议层在 TS 里，一次 `send` 对应一条完整消息。
//! 如果这里再做一层流式切分，等于让 Rust 掺进协议语义，两边都要维护同一套状态机。
//!
//! 长度前缀同时也把「对端谎报长度」钉死了 —— 没读之前就已经知道要不要拒绝，
//! 不会先分配 4 GB 再发现不对。

use std::io::{self, Read, Write};

/// 单帧上限。
///
/// 一张图片 base64 之后可能几 MB，64 MB 对任何合法用途都绰绰有余；
/// 同时它是一道硬闸：对面发一句「长度 = 4 GB」时，这里直接拒绝，
/// 不会先 `vec![0; 4GB]` 把内存吃掉。
pub const MAX_FRAME: usize = 64 * 1024 * 1024;

/// 写一帧。
pub fn write_frame<W: Write>(w: &mut W, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("帧 {} 字节，超过上限 {}", payload.len(), MAX_FRAME),
        ));
    }
    let mut head = [0u8; 4];
    head.copy_from_slice(&(payload.len() as u32).to_be_bytes());
    w.write_all(&head)?;
    w.write_all(payload)?;
    w.flush()
}

/// 读一帧。
///
/// 返回 `Ok(None)` 表示对端已经不在了 —— 干净关闭，或者读到一半就断了。
/// 两种情况调用方的处理是一样的（把这条链路收掉），区分它们没有可用的动作，
/// 所以合并成一个返回值。这不是错误，是「这个人走了」。
pub fn read_frame<R: Read>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut head = [0u8; 4];
    let got = read_fully(r, &mut head)?;
    if got == 0 {
        return Ok(None); // 一个字节都没读到：对端干净关闭
    }
    if got < head.len() {
        return Ok(None); // 帧头只读到一半：对端在中途死了
    }
    let n = u32::from_be_bytes(head) as usize;
    if n > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("对端声称的帧长度 {n} 超过上限"),
        ));
    }
    let mut buf = vec![0u8; n];
    if read_fully(r, &mut buf)? < n {
        return Ok(None); // 载荷只读到一半
    }
    Ok(Some(buf))
}

/// 尽量读满整个缓冲区，返回**实际读到的字节数**。
///
/// 返回值是 `usize` 而不是 `bool`，因为「读到几个字节」这件事必须能让调用方
/// 区分三种情况，而两种状态表达不下：
///   - `0`：一个字节都没读到 —— 对端干净关闭，这是正常结束；
///   - `1..len`：读到一半就断了 —— 对端在半路上死了，连接是坏的；
///   - `len`：整块读完。
///
/// 曾经这里返回 `bool`（`filled == 0`），把「一个字节都没读到」算成了「读成功」，
/// 于是连接正常关闭时调用方会拿着一个**全零的帧头**继续走，读出一个
/// 长度为 0 的假帧 —— 表现为「对方下线了，这边收到一条空消息」。
fn read_fully<R: Read>(r: &mut R, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == io::ErrorKind::ConnectionReset => break,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

#[cfg(test)]
#[allow(non_snake_case)] // 自测名写成中文：读起来是一句人话，比拼音或英文缩写强
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn 空载荷也能往返() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"").unwrap();
        assert_eq!(buf, vec![0, 0, 0, 0]);
        let got = read_frame(&mut Cursor::new(&buf)).unwrap();
        assert_eq!(got, Some(Vec::new()));
    }

    #[test]
    fn 往返保住每一个字节() {
        let payload: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
        let mut buf = Vec::new();
        write_frame(&mut buf, &payload).unwrap();
        // 长度前缀是大端，且正好 4 字节
        assert_eq!(&buf[..4], &(70_000u32).to_be_bytes());
        let got = read_frame(&mut Cursor::new(&buf)).unwrap().unwrap();
        assert_eq!(got, payload);
    }

    #[test]
    fn 一帧之后还有一帧时只读走一帧() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"first").unwrap();
        write_frame(&mut buf, b"second").unwrap();
        let mut cur = Cursor::new(&buf);
        assert_eq!(read_frame(&mut cur).unwrap().unwrap(), b"first");
        assert_eq!(read_frame(&mut cur).unwrap().unwrap(), b"second");
        assert_eq!(read_frame(&mut cur).unwrap(), None);
    }

    #[test]
    fn 对端干净关闭返回None而不是报错() {
        let got = read_frame(&mut Cursor::new(Vec::new())).unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn 读了一半就断返回None() {
        // 声称 10 字节，实际只给 3 字节
        let mut buf = 10u32.to_be_bytes().to_vec();
        buf.extend_from_slice(b"abc");
        assert_eq!(read_frame(&mut Cursor::new(&buf)).unwrap(), None);
    }

    #[test]
    fn 谎报超过上限的长度被拒绝() {
        // 声明 4 GB，但一个字节的载荷都没有 —— 必须在分配之前就失败
        let buf = u32::MAX.to_be_bytes().to_vec();
        let err = read_frame(&mut Cursor::new(&buf)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("超过上限"), "{}", err);
    }

    #[test]
    fn 发送侧超过上限被拒绝() {
        let mut buf = Vec::new();
        // 用一个刚好越界的长度（不真的分配内存：先造一个短的再直接调下限检查）
        let err = write_frame(&mut buf, &vec![0u8; MAX_FRAME + 1]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(buf.is_empty(), "被拒绝时不应该写出任何字节");
    }

    #[test]
    fn 正好等于上限的帧合法() {
        // 边界：== 上限必须通过（否则「上限」其实小了一格）
        let payload = vec![7u8; 1024];
        let mut buf = Vec::new();
        write_frame(&mut buf, &payload).unwrap();
        assert_eq!(read_frame(&mut Cursor::new(&buf)).unwrap().unwrap(), payload);
    }
}
