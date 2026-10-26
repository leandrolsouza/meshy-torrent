/**
 * @jest-environment jsdom
 */
/**
 * Testes unitários para o hook usePolling.
 *
 * Cobre: chamada inicial imediata, polling periódico, cleanup ao desabilitar,
 * atualização da referência da função, e mudança de intervalo.
 */
import { renderHook, act } from '@testing-library/react';
import { usePolling } from '../../../src/hooks/usePolling';

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('usePolling', () => {
    describe('quando enabled é true', () => {
        it('executa a função imediatamente ao montar', () => {
            const fn = jest.fn().mockResolvedValue(undefined);

            renderHook(() => usePolling(fn, 2000, true));

            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('executa a função periodicamente no intervalo especificado', async () => {
            const fn = jest.fn().mockResolvedValue(undefined);

            renderHook(() => usePolling(fn, 2000, true));
            await act(async () => {
                await Promise.resolve();
            });

            // Chamada inicial
            expect(fn).toHaveBeenCalledTimes(1);

            // Avança 2 segundos
            act(() => {
                jest.advanceTimersByTime(2000);
            });
            expect(fn).toHaveBeenCalledTimes(2);
            await act(async () => {
                await Promise.resolve();
            });

            // Avança mais 2 segundos
            act(() => {
                jest.advanceTimersByTime(2000);
            });
            expect(fn).toHaveBeenCalledTimes(3);
        });

        it('não inicia outra chamada enquanto a anterior está pendente', async () => {
            let resolveFirst!: () => void;
            const fn = jest
                .fn<Promise<void>, []>()
                .mockImplementationOnce(
                    () =>
                        new Promise<void>((resolve) => {
                            resolveFirst = resolve;
                        }),
                )
                .mockResolvedValue(undefined);

            renderHook(() => usePolling(fn, 2000, true));
            expect(fn).toHaveBeenCalledTimes(1);

            act(() => {
                jest.advanceTimersByTime(6000);
            });
            expect(fn).toHaveBeenCalledTimes(1);

            await act(async () => {
                resolveFirst();
                await Promise.resolve();
            });

            act(() => {
                jest.advanceTimersByTime(2000);
            });
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('limpa o intervalo ao desmontar', () => {
            const fn = jest.fn().mockResolvedValue(undefined);

            const { unmount } = renderHook(() => usePolling(fn, 2000, true));

            expect(fn).toHaveBeenCalledTimes(1);

            unmount();

            act(() => {
                jest.advanceTimersByTime(4000);
            });

            // Não deve ter chamado novamente após unmount
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });

    describe('quando enabled é false', () => {
        it('não executa a função', () => {
            const fn = jest.fn().mockResolvedValue(undefined);

            renderHook(() => usePolling(fn, 2000, false));

            expect(fn).not.toHaveBeenCalled();

            act(() => {
                jest.advanceTimersByTime(4000);
            });

            expect(fn).not.toHaveBeenCalled();
        });
    });

    describe('transição de enabled', () => {
        it('inicia polling quando enabled muda de false para true', async () => {
            const fn = jest.fn().mockResolvedValue(undefined);

            const { rerender } = renderHook(({ enabled }) => usePolling(fn, 2000, enabled), {
                initialProps: { enabled: false },
            });

            expect(fn).not.toHaveBeenCalled();

            rerender({ enabled: true });

            // Chamada inicial imediata
            expect(fn).toHaveBeenCalledTimes(1);
            await act(async () => {
                await Promise.resolve();
            });

            act(() => {
                jest.advanceTimersByTime(2000);
            });
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('para polling quando enabled muda de true para false', () => {
            const fn = jest.fn().mockResolvedValue(undefined);

            const { rerender } = renderHook(({ enabled }) => usePolling(fn, 2000, enabled), {
                initialProps: { enabled: true },
            });

            // Chamada inicial
            expect(fn).toHaveBeenCalledTimes(1);

            rerender({ enabled: false });

            act(() => {
                jest.advanceTimersByTime(4000);
            });

            // Não deve ter chamado novamente após desabilitar
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });

    describe('referência estável da função', () => {
        it('usa a versão mais recente da função via ref', async () => {
            const fn1 = jest.fn().mockResolvedValue(undefined);
            const fn2 = jest.fn().mockResolvedValue(undefined);

            const { rerender } = renderHook(({ fn }) => usePolling(fn, 2000, true), {
                initialProps: { fn: fn1 },
            });

            // Chamada inicial com fn1
            expect(fn1).toHaveBeenCalledTimes(1);
            expect(fn2).not.toHaveBeenCalled();
            await act(async () => {
                await Promise.resolve();
            });

            // Atualiza a função sem reiniciar o intervalo
            rerender({ fn: fn2 });

            act(() => {
                jest.advanceTimersByTime(2000);
            });

            // O intervalo deve usar fn2 (a versão mais recente)
            expect(fn2).toHaveBeenCalledTimes(1);
        });
    });

    describe('mudança de intervalo', () => {
        it('reinicia o intervalo quando intervalMs muda', async () => {
            const fn = jest.fn().mockResolvedValue(undefined);

            const { rerender } = renderHook(({ intervalMs }) => usePolling(fn, intervalMs, true), {
                initialProps: { intervalMs: 2000 },
            });

            // Chamada inicial
            expect(fn).toHaveBeenCalledTimes(1);
            await act(async () => {
                await Promise.resolve();
            });

            // Muda intervalo para 1000ms — deve executar chamada inicial novamente
            rerender({ intervalMs: 1000 });
            expect(fn).toHaveBeenCalledTimes(2);
            await act(async () => {
                await Promise.resolve();
            });

            act(() => {
                jest.advanceTimersByTime(1000);
            });
            expect(fn).toHaveBeenCalledTimes(3);
        });
    });
});
