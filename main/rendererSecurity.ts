import type { BrowserWindow } from 'electron';

/** Autoriza somente o documento do app; mudanças de fragmento não trocam o documento. */
export function isAllowedRendererUrl(url: string, rendererUrl: string): boolean {
    try {
        const actual = new URL(url);
        const expected = new URL(rendererUrl);
        if (
            !['file:', 'http:', 'https:'].includes(expected.protocol) ||
            actual.username ||
            actual.password
        )
            return false;
        actual.hash = '';
        expected.hash = '';
        return actual.href === expected.href;
    } catch {
        return false;
    }
}

export function createRendererSecurity() {
    const trustedContents = new WeakMap<Electron.WebContents, string>();
    return {
        trustWindow(window: BrowserWindow, rendererUrl: string): void {
            const contents = window.webContents;
            trustedContents.set(contents, rendererUrl);
            window.once('closed', () => trustedContents.delete(contents));
        },
        isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
            try {
                const contents = event?.sender;
                const frame = event?.senderFrame;
                const rendererUrl = trustedContents.get(contents);
                return Boolean(
                    rendererUrl &&
                    frame &&
                    !contents.isDestroyed() &&
                    frame === contents.mainFrame &&
                    isAllowedRendererUrl(frame.url, rendererUrl),
                );
            } catch {
                // Frames destruídos ou eventos incompletos nunca são autorizados.
                return false;
            }
        },
    };
}

export const rendererSecurity = createRendererSecurity();
export const isTrustedIpcSender = (event: Electron.IpcMainInvokeEvent): boolean =>
    rendererSecurity.isTrustedSender(event);
