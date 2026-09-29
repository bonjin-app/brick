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

  /**
   * `doAction` 과 같지만 **한 구독자라도 실패하면 끝에서 던진다** (나머지는 끝까지 돈다).
   *
   * `doAction` 은 실패를 삼키므로 "알린 쪽" 은 누가 못 받았는지 알 길이 없다. 다시 시도해도 되는 알림
   * (구독자가 멱등인 것 — 예: 주문번호로 한 번만 쌓이는 구매 적립)을 재처리 대상으로 삼으려면 실패가 보여야 한다.
   * 던지는 쪽은 자기 작업을 "끝난 것" 으로 기록하지 말아야 한다.
   */
  async doActionOrThrow<T>(hook: string, payload: T): Promise<void> {
    const failed: string[] = [];
    for (const reg of this.actions.get(hook) ?? []) {
      try {
        await (reg.handler as ActionHandler<T>)(payload);
      } catch (err) {
        console.error(`[hook:${hook}] plugin "${reg.pluginName}" action failed`, err);
        failed.push(reg.pluginName);
      }
    }
    if (failed.length) throw new Error(`[hook:${hook}] 실패한 구독자: ${failed.join(", ")}`);
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
