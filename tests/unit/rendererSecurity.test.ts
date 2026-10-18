import { EventEmitter } from 'events';
import type { BrowserWindow } from 'electron';
import { createRendererSecurity, isAllowedRendererUrl } from '../../main/rendererSecurity';

const rendererUrl = 'file:///C:/Meshy/renderer/index.html';

test.each([
    'http://localhost.attacker.example/',
    'http://localhost:4444/',
    'file:///C:/untrusted/index.html',
    `${rendererUrl}?other=document`,
    'javascript:alert(1)',
    'data:text/html,test',
    'invalid',
])('bloqueia documento diferente: %s', (url) => {
    expect(isAllowedRendererUrl(url, rendererUrl)).toBe(false);
});

test('autoriza somente a URL de desenvolvimento exata e fragmentos do app', () => {
    const dev = 'http://localhost:5173/';
    expect(isAllowedRendererUrl(`${dev}#details`, dev)).toBe(true);
    expect(isAllowedRendererUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAllowedRendererUrl('http://localhost:5173/other.html', dev)).toBe(false);
    expect(isAllowedRendererUrl('http://user@localhost:5173/', dev)).toBe(false);
    expect(isAllowedRendererUrl(`${rendererUrl}#downloads`, rendererUrl)).toBe(true);
});

test('confiança exige janela registrada, frame principal vivo e documento autorizado', () => {
    const security = createRendererSecurity();
    const frame = { url: rendererUrl };
    const contents = { mainFrame: frame, isDestroyed: jest.fn(() => false) };
    const window = Object.assign(new EventEmitter(), { webContents: contents });
    const event = {
        sender: contents,
        senderFrame: frame,
    } as unknown as Electron.IpcMainInvokeEvent;
    expect(security.isTrustedSender(event)).toBe(false);
    security.trustWindow(window as unknown as BrowserWindow, rendererUrl);
    expect(security.isTrustedSender(event)).toBe(true);
    expect(security.isTrustedSender({ ...event, senderFrame: null })).toBe(false);
    expect(
        security.isTrustedSender({
            ...event,
            senderFrame: { url: rendererUrl } as Electron.WebFrameMain,
        }),
    ).toBe(false);
    frame.url = 'file:///C:/untrusted/index.html';
    expect(security.isTrustedSender(event)).toBe(false);
    frame.url = rendererUrl;
    contents.isDestroyed.mockReturnValue(true);
    expect(security.isTrustedSender(event)).toBe(false);
    contents.isDestroyed.mockReturnValue(false);
    window.emit('closed');
    expect(security.isTrustedSender(event)).toBe(false);
    expect(security.isTrustedSender(null as unknown as Electron.IpcMainInvokeEvent)).toBe(false);
});

test('uma nova janela só é autorizada após registro e não herda a confiança da anterior', () => {
    const security = createRendererSecurity();
    const frame = { url: rendererUrl };
    const first = { mainFrame: frame, isDestroyed: () => false };
    const next = { mainFrame: frame, isDestroyed: () => false };
    const firstWindow = Object.assign(new EventEmitter(), { webContents: first });
    security.trustWindow(firstWindow as unknown as BrowserWindow, rendererUrl);
    const event = { sender: next, senderFrame: frame } as unknown as Electron.IpcMainInvokeEvent;
    expect(security.isTrustedSender(event)).toBe(false);
    firstWindow.emit('closed');
    const nextWindow = Object.assign(new EventEmitter(), { webContents: next });
    security.trustWindow(nextWindow as unknown as BrowserWindow, rendererUrl);
    expect(security.isTrustedSender(event)).toBe(true);
});
