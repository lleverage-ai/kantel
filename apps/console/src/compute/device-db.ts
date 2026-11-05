// Where the hosted console's browser device keeps its keys and trust: IndexedDB, which keeps WebCrypto keys as they
// are (non-extractable stays so). Every change is one read-write transaction that reads what is kept and writes what
// replaces it, so two tabs (or two calls in one) can't both act on what they read before the other wrote: IndexedDB
// runs read-write transactions on one store one at a time, across every connection.
//
// No imports: browser-device.test.ts loads this file as it is into a real browser to check that across tabs.

export type DeviceStore = "keys" | "trust";

export interface DeviceDb {
	get<T>(store: DeviceStore, key: string): Promise<T | undefined>;
	/**
	 * One step: `change` gets what is kept and answers what to keep instead, or undefined to keep it; what it throws
	 * refuses the change and nothing is written. Answers what is kept after. `change` runs inside the transaction, so it
	 * mustn't wait on anything.
	 */
	update<T>(store: DeviceStore, key: string, change: (current: T | undefined) => T | undefined): Promise<T | undefined>;
}

export const DEVICE_DB_NAME = "kantel-e2e";

/** The browser's IndexedDB as a `DeviceDb`; undefined where there is none. */
export function indexedDeviceDb(
	factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB,
	name = DEVICE_DB_NAME,
): DeviceDb | undefined {
	if (factory === undefined) return undefined;
	let opened: Promise<IDBDatabase> | undefined;
	const open = () => {
		opened ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open(name, 1);
			request.onupgradeneeded = () => {
				request.result.createObjectStore("keys");
				request.result.createObjectStore("trust");
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error("This browser couldn't open its key store"));
		});
		return opened;
	};
	const failed = (transaction: IDBTransaction) => transaction.error ?? new Error("This browser's key store failed");
	return {
		get: async <T>(store: DeviceStore, key: string) => {
			const db = await open();
			return new Promise<T | undefined>((resolve, reject) => {
				const transaction = db.transaction(store, "readonly");
				const request = transaction.objectStore(store).get(key);
				transaction.oncomplete = () => resolve(request.result as T | undefined);
				transaction.onabort = () => reject(failed(transaction));
			});
		},
		update: async <T>(store: DeviceStore, key: string, change: (current: T | undefined) => T | undefined) => {
			const db = await open();
			return new Promise<T | undefined>((resolve, reject) => {
				const transaction = db.transaction(store, "readwrite");
				const objects = transaction.objectStore(store);
				let kept: T | undefined;
				let refused: unknown;
				const read = objects.get(key);
				read.onsuccess = () => {
					const current = read.result as T | undefined;
					try {
						const next = change(current);
						kept = next === undefined ? current : next;
						if (next !== undefined) objects.put(next, key);
					} catch (error) {
						refused = error;
						transaction.abort();
					}
				};
				transaction.oncomplete = () => resolve(kept);
				transaction.onabort = () => reject(refused ?? failed(transaction));
			});
		},
	};
}
