import React, { useState } from 'react';
import { Icon } from '../../UI/Icons';

interface ActionButtonProps {
    id?: string;
    type?: 'copy' | 'download' | 'preview' | 'custom';
    icon: string;
    text: string;
    title?: string;
    disabled?: boolean;
    className?: string;
    onClick?: () => void;
    content?: string | (() => string);
    filename?: string;
}

export const ActionButton: React.FC<ActionButtonProps> = ({
    id,
    type = 'custom',
    icon,
    text,
    title,
    disabled = false,
    className = '',
    onClick,
    content,
    filename = 'file.txt'
}) => {
    const [status, setStatus] = useState<'idle' | 'success'>('idle');

    const handleClick = async () => {
        if (disabled) return;
        const finalContent = typeof content === 'function' ? content() : content;

        if (type === 'copy' && finalContent) {
            try {
                await navigator.clipboard.writeText(finalContent);
                setStatus('success');
                setTimeout(() => setStatus('idle'), 1500);
            } catch (err) {
                console.error('Failed to copy to clipboard:', err);
            }
        } else if (type === 'download' && finalContent) {
            const blob = new Blob([finalContent], { type: filename.endsWith('html') ? 'text/html' : 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        onClick?.();
    };

    const baseClass = type === 'copy' ? 'copy-solution-btn' : type === 'download' ? 'download-solution-btn' : 'action-btn';

    return (
        <button
            id={id}
            className={`button ${baseClass} ${className} ${status === 'success' ? 'copied' : ''}`}
            type="button"
            title={title || text}
            disabled={disabled}
            onClick={handleClick}
        >
            <Icon name={status === 'success' ? 'check' : icon} />
            <span className="button-text">{status === 'success' ? 'Copied!' : text}</span>
        </button>
    );
};
