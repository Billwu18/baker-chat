import { useCallback, useEffect, useState } from 'react'
import { ChatProvider, useChatState, useChatStore } from './store/ChatProvider'
import { UiSettingsProvider } from './store/uiSettings'
import { totalUnread } from './store/chatStore'
import { BakerTitle } from './components/BakerTitle'
import { SessionList } from './components/SessionList'
import { Conversation } from './components/Conversation'
import { SettingsPanel } from './components/SettingsPanel'
import { ErrorBanner } from './components/ErrorBanner'
import { BakerTabBar, CloseButton } from './components/BakerTabBar'
import { SearchPanel } from './components/SearchPanel'
import { AnnouncementsPanel } from './components/AnnouncementsPanel'
import { FriendPanel } from './components/FriendPanel'
import { useNotifications } from './hooks/useNotifications'
import backgroundUrl from './assets/baker/background/app-background.webp'

/**
 * 应用外壳。
 *
 * 布局与游戏一致：顶部标题栏，下面是「会话列表 + 会话区」两栏。
 * 点标题打开设置，对应游戏里 #title 是 cursor: pointer 的设计。
 */
function BakerApp() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [noticeOpen, setNoticeOpen] = useState(false)
  const [friendOpen, setFriendOpen] = useState(false)
  const { connection, self, sessions, announcementUnread, friends, followersSeen } = useChatState()
  const store = useChatStore()

  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const closeSearch = useCallback(() => setSearchOpen(false), [])
  const closeNotice = useCallback(() => setNoticeOpen(false), [])
  const closeFriend = useCallback(() => setFriendOpen(false), [])

  // 打开好友面板 = 看过这批「想加你的人」，顶栏红点灭掉
  const openFriend = useCallback(() => {
    store.markFollowersSeen()
    setFriendOpen(true)
  }, [store])

  // 红点含义是「有人 pin 了你，你还没看过」，而不是「有 followers」——
  // 后者在对方一直不撤回 pin 的时候永远消不掉。
  const friendUnread = friends.followers.some((id) => !followersSeen.includes(id))

  useNotifications()

  const unread = totalUnread(sessions)

  // Ctrl/Cmd+K 开搜索，是最常用的一个快捷键，顺手加上
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 任务栏 / 窗口标题上挂未读数，最小化时也能看出来有新消息
  useEffect(() => {
    document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) BAKER` : 'BAKER'
  }, [unread])

  // 启动时把构建信息打到控制台，用来回答「我到底跑的是哪一版」。
  useEffect(() => {
    console.info(
      `%cBAKER ${__BUILD_KIND__} · 构建于 ${__BUILD_STAMP__}`,
      'background:#ffef00;color:#000;padding:2px 6px;font-weight:600',
    )
  }, [])

  return (
    <>
      <img id="background-image" src={backgroundUrl} alt="" aria-hidden="true" />
      <div id="app-backdrop" aria-hidden="true" />

      {/* 游戏里 Baker 是手机上的应用，顶部有一条居中的 SNS 标签栏 */}
      <BakerTabBar
        onSearch={() => setSearchOpen(true)}
        onNotice={() => setNoticeOpen(true)}
        onFriend={openFriend}
        onSettings={openSettings}
        unread={unread}
        noticeUnread={announcementUnread}
        friendUnread={friendUnread}
      />
      <CloseButton />

      <div id="app">
        <BakerTitle connection={connection} uid={self.number} />

        <div id="main-content">
          <SessionList />
          <Conversation />
        </div>
      </div>

      {searchOpen && <SearchPanel onClose={closeSearch} />}
      {noticeOpen && <AnnouncementsPanel onClose={closeNotice} />}
      {friendOpen && <FriendPanel onClose={closeFriend} />}
      {settingsOpen && <SettingsPanel onClose={closeSettings} />}
      <ErrorBanner />
    </>
  )
}

export default function App() {
  return (
    <UiSettingsProvider>
      <ChatProvider>
        <BakerApp />
      </ChatProvider>
    </UiSettingsProvider>
  )
}
