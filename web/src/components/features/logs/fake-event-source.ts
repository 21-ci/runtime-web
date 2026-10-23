// FakeEventSource is a test double for the browser EventSource. Tests drive it with emit / open / fail.
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Set<(e: Event) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.get(type)?.delete(fn);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  // Test helpers.
  open() {
    this.readyState = 1;
    this.dispatch("open", new Event("open"));
  }

  emit(type: string, data: unknown, lastEventId = "") {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    this.dispatch(type, new MessageEvent(type, { data: body, lastEventId }));
  }

  // fail simulates a dropped connection: a native error event with no data.
  fail(reconnecting = true) {
    this.readyState = reconnecting ? 0 : 2;
    this.dispatch("error", new Event("error"));
  }

  private dispatch(type: string, ev: Event) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}
