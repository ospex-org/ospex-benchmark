import { MarketOpenStore, type MarketOpenStoreConfig } from '../marketOpenStore.js';

let store: MarketOpenStore | undefined;
process.on('message', (message: MarketOpenStoreConfig | 'close') => {
  if (message === 'close') { store?.close(); process.disconnect(); return; }
  try { store = new MarketOpenStore(message); process.send!({ acquired: true }); }
  catch (error) { process.send!({ acquired: false, error: (error as Error).message }); }
});
process.send!({ ready: true });
