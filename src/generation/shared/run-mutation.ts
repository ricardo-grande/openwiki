/**
 * Process-local serialization of durable run mutations, keyed by run identity.
 *
 * Page workers may run concurrently, but every read-modify-write of the run
 * checkpoint and any state shared with it must observe the previous
 * mutation's result. Keying by object identity keeps the durable state shape
 * unchanged and lets the drivers stay unaware of the lock.
 */
const runMutations = new WeakMap<object, Promise<void>>();

/**
 * Runs one durable mutation after every earlier mutation on the same run.
 *
 * The model-owned work of a page worker happens outside this lock; only the
 * bookkeeping that advances shared state is serialized, so concurrent workers
 * cost nothing here while still never losing a completion.
 *
 * @param run - Active run whose shared state the operation mutates.
 * @param operation - Mutation that reads run state only once it holds the lock.
 * @returns The operation's result.
 */
export async function withRunMutation<T>(
  run: object,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = runMutations.get(run) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  runMutations.set(run, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
