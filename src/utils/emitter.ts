/**
 * 极小的类型安全事件发射器。
 *
 * 比自己手写 Map<string, Set<Function>> 强的地方在于：事件名和 payload 是绑定的，
 * 写错事件名或多传字段都会在编译期报错。
 */
export type Listener<T> = (payload: T) => void
export type Unsubscribe = () => void

export class Emitter<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>()

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as Listener<never>)
    return () => {
      set.delete(listener as Listener<never>)
    }
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    // 复制一份再遍历：回调里取消订阅不会打乱本轮派发
    for (const listener of Array.from(set)) {
      ;(listener as Listener<Events[K]>)(payload)
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
