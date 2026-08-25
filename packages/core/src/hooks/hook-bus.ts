/**
 * HookBus — Brick의 WordPress식 action/filter 시스템.
 *
 *  - action: 이벤트 통지 (post.created, user.registered, ...)
 *  - filter: 값 변형 파이프라인 (content.render, seo.meta, ...)
 *
 * 플러그인은 같은 프로세스 안에서 이 버스에 등록한다.
 */
type ActionHandler<T> = (payload: T) => void | Promise<void>;
type FilterHandler<T> = (value: T) => T | Promise<T>;

interface Registration {
  pluginName: string;
  priority: number;
  handler: ActionHandler<unknown> | FilterHandler<unknown>;
}

export class HookBus {
  private actions = new Map<string, Registration[]>();
  private filters = new Map<string, Registration[]>();

  onAction<T>(hook: string, pluginName: string, handler: ActionHandler<T>, priority = 10): void {
    this.register(this.actions, hook, { pluginName, priority, handler: handler as ActionHandler<unknown> });
  }

  onFilter<T>(hook: string, pluginName: string, handler: FilterHandler<T>, priority = 10): void {
    this.register(this.filters, hook, { pluginName, priority, handler: handler as FilterHandler<unknown> });
  }

  async doAction<T>(hook: string, payload: T): Promise<void> {
    for (const reg of this.actions.get(hook) ?? []) {
      // 한 플러그인의 실패가 다른 플러그인을 막지 않는다
      try {
        await (reg.handler as ActionHandler<T>)(payload);
      } catch (err) {
        console.error(`[hook:${hook}] plugin "${reg.pluginName}" action failed`, err);
      }
    }
  }

  async applyFilter<T>(hook: string, value: T): Promise<T> {
    let current = value;
    for (const reg of this.filters.get(hook) ?? []) {
      current = await (reg.handler as FilterHandler<T>)(current);
    }
    return current;
  }

  /** 플러그인 비활성화 시 해당 플러그인의 등록을 모두 제거 */
  removePlugin(pluginName: string): void {
    for (const map of [this.actions, this.filters]) {
      for (const [hook, regs] of map) {
        map.set(hook, regs.filter((r) => r.pluginName !== pluginName));
      }
    }
  }

  private register(map: Map<string, Registration[]>, hook: string, reg: Registration): void {
    const list = map.get(hook) ?? [];
    list.push(reg);
    list.sort((a, b) => a.priority - b.priority);
    map.set(hook, list);
  }
}
