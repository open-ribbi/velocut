// di/container.ts — a deliberately tiny DI container: typed tokens,
// factories with access to the container, memoized singletons. Enough to
// keep services swappable (engine: wasm/ts; renderer: webgpu/webgl2 later)
// without dragging in a framework.

export interface Token<T> {
  readonly key: symbol;
  readonly description: string;
  readonly _type?: T;
}

export function token<T>(description: string): Token<T> {
  return { key: Symbol(description), description };
}

type Factory<T> = (c: Container) => T;

export class Container {
  private factories = new Map<symbol, Factory<unknown>>();
  private instances = new Map<symbol, unknown>();

  register<T>(tok: Token<T>, factory: Factory<T>): this {
    this.factories.set(tok.key, factory as Factory<unknown>);
    return this;
  }

  /** Register an already-constructed instance. */
  registerValue<T>(tok: Token<T>, value: T): this {
    this.instances.set(tok.key, value);
    return this;
  }

  resolve<T>(tok: Token<T>): T {
    if (this.instances.has(tok.key)) return this.instances.get(tok.key) as T;
    const factory = this.factories.get(tok.key);
    if (!factory) throw new Error(`DI: no provider for ${tok.description}`);
    const instance = factory(this) as T;
    this.instances.set(tok.key, instance);
    return instance;
  }
}
