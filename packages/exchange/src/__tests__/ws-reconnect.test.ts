import EventEmitter from 'events';

// Capture the WebSocket constructor so tests can control events.
let mockWsInstance: EventEmitter & { readyState: number; removeAllListeners: jest.Mock; close: jest.Mock };
const MockWebSocket = jest.fn().mockImplementation(() => {
  mockWsInstance = Object.assign(new EventEmitter(), {
    readyState: 1,
    removeAllListeners: jest.fn(),
    close: jest.fn(),
  });
  return mockWsInstance;
});

jest.mock('ws', () => MockWebSocket);

import { BinanceTestnetWsManager } from '../ws-manager';

describe('BinanceTestnetWsManager reconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('calls onTick with kline data on message', () => {
    const manager = new BinanceTestnetWsManager();
    const onTick = jest.fn();
    manager.subscribeKline('BTCUSDT', '1m', onTick);

    const kline = { t: 1, T: 2, s: 'BTCUSDT', i: '1m', o: '100', h: '110', l: '90', c: '105', v: '500', x: false };
    mockWsInstance.emit('message', JSON.stringify({ k: kline }));

    expect(onTick).toHaveBeenCalledWith(kline);
  });

  it('reconnects after close with backoff', () => {
    const manager = new BinanceTestnetWsManager();
    const onTick = jest.fn();
    const onReconnect = jest.fn();
    manager.subscribeKline('BTCUSDT', '1m', onTick, onReconnect);

    const firstCallCount = MockWebSocket.mock.calls.length;

    // Simulate disconnect
    mockWsInstance.emit('close');

    // Fast-forward past the backoff delay
    jest.runAllTimers();

    // A new WebSocket connection should have been created
    expect(MockWebSocket.mock.calls.length).toBeGreaterThan(firstCallCount);
    expect(onReconnect).toHaveBeenCalled();
  });

  it('closeAll terminates connections without triggering reconnect', () => {
    const manager = new BinanceTestnetWsManager();
    manager.subscribeKline('BTCUSDT', '1m', jest.fn());

    const connectCount = MockWebSocket.mock.calls.length;
    manager.closeAll();

    expect(mockWsInstance.removeAllListeners).toHaveBeenCalled();
    expect(mockWsInstance.close).toHaveBeenCalled();

    // No new connections after close
    jest.runAllTimers();
    expect(MockWebSocket.mock.calls.length).toBe(connectCount);
  });
});
