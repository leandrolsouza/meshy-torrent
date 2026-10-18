/** @jest-environment jsdom */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { IntlProvider } from 'react-intl';
import { NetworkSettings } from '../../src/components/Settings/NetworkSettings';
import ptBR from '../../src/locales/pt-BR.json';
import enUS from '../../src/locales/en-US.json';

test.each([
    ['pt-BR', ptBR, 'Ativar seeding', 'Seeders simultâneos'],
    ['en-US', enUS, 'Enable seeding', 'Concurrent seeders'],
] as const)('controles acessíveis de seed em %s', (locale, messages, toggleName, maxName) => {
    const change = jest.fn();
    const props = {
        dhtEnabled: true,
        pexEnabled: true,
        utpEnabled: true,
        onDhtChange: jest.fn(),
        onPexChange: jest.fn(),
        onUtpChange: jest.fn(),
        maxConcurrentSeeders: 2,
        onSeedingChange: change,
        onMaxSeedersChange: change,
    };
    const { rerender } = render(
        <IntlProvider locale={locale} messages={messages}>
            <NetworkSettings {...props} seedingEnabled={false} />
        </IntlProvider>,
    );
    expect(screen.getByRole('spinbutton', { name: maxName })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: toggleName }));
    expect(change).toHaveBeenCalledWith(true);
    rerender(
        <IntlProvider locale={locale} messages={messages}>
            <NetworkSettings {...props} seedingEnabled />
        </IntlProvider>,
    );
    const input = screen.getByRole('spinbutton', { name: maxName });
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '20');
    fireEvent.change(input, { target: { value: '4' } });
    expect(change).toHaveBeenCalledWith(4);
});
