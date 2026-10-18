/** @jest-environment jsdom */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ActionMenu } from '../../src/components/common/ActionMenu';

test('abre por botão, foca a primeira ação disponível e Escape devolve foco', () => {
    render(
        <ActionMenu label="Mais ações">
            <button disabled>Indisponível</button>
            <button>Gerenciar</button>
        </ActionMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Mais ações' });
    expect(screen.queryByRole('button', { name: 'Gerenciar' })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const action = screen.getByRole('button', { name: 'Gerenciar' });
    expect(action).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(action, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('executa a ação antes de fechar o popover e permite abrir um diálogo', () => {
    const onRemove = jest.fn();
    render(
        <ActionMenu label="Mais ações">
            <button onClick={onRemove}>Remover</button>
        </ActionMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Mais ações' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
});

test('ação não é desmontada antes de abrir a confirmação', () => {
    function Harness(): React.JSX.Element {
        const [confirmOpen, setConfirmOpen] = React.useState(false);
        return (
            <>
                <ActionMenu label="Mais ações">
                    <button onClick={() => setConfirmOpen(true)}>Remover</button>
                </ActionMenu>
                {confirmOpen && <div role="dialog">Confirmar remoção</div>}
            </>
        );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
});

test('fecha ao clicar fora ou ao sair com teclado', () => {
    render(
        <>
            <ActionMenu label="Mais ações">
                <button>Ação</button>
            </ActionMenu>
            <button>Fora</button>
        </>,
    );
    const trigger = screen.getByRole('button', { name: 'Mais ações' });
    const outside = screen.getByRole('button', { name: 'Fora' });
    fireEvent.click(trigger);
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    act(() => outside.focus());
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
});
