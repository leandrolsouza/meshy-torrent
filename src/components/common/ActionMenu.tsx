import React, { useEffect, useId, useRef, useState } from 'react';
import styles from './ActionMenu.module.css';

/** Popover de ações com botões nativos e navegação por Tab. */
export function ActionMenu({
    label,
    children,
    disabled = false,
}: {
    label: string;
    children: React.ReactNode;
    disabled?: boolean;
}): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const id = useId();
    const container = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const content = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        content.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
        const outside = (event: PointerEvent) => {
            if (event.target instanceof Node && !container.current?.contains(event.target))
                setOpen(false);
        };
        document.addEventListener('pointerdown', outside);
        return () => document.removeEventListener('pointerdown', outside);
    }, [open]);

    return (
        <div
            ref={container}
            className={styles.container}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape' && open) {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                    trigger.current?.focus();
                }
            }}
        >
            <button
                ref={trigger}
                type="button"
                className="btn"
                aria-label={label}
                title={label}
                aria-expanded={open}
                aria-controls={id}
                disabled={disabled}
                onClick={() => setOpen((previous) => !previous)}
            >
                <span aria-hidden="true">⋯</span>
            </button>
            {open && (
                <div
                    ref={content}
                    id={id}
                    role="group"
                    aria-label={label}
                    className={styles.popover}
                    onClick={(event) => {
                        if (event.target instanceof Element && event.target.closest('button')) {
                            trigger.current?.focus();
                            setOpen(false);
                        }
                    }}
                >
                    {children}
                </div>
            )}
        </div>
    );
}
