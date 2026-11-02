import React, { useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { Icon } from '../../../UI/Icons';
import type { SandboxToolExecutionTrace, SandboxToolExecutionTraceMessage } from '../../../Core/SandboxToolRuntime';
import { MessageCard, type AdaptiveMessage, type ResponseSegment, type SystemBlock } from '../../../AdaptiveDeepthink/AdaptiveDeepthinkMode';

export interface AgentActivityPanelProps {
    title?: string;
    isProcessing?: boolean;
    error?: string | null;
    onStop?: () => void;
    headerExtra?: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    children?: React.ReactNode;
}

const STOP_ICON = <Icon name="stop_circle" />;
const WARNING_ICON = <Icon name="warning" />;
const PROCESSING_INDICATOR = (
    <div className="processing-indicator">
        <div className="spinner" />
        <span>Processing agent response...</span>
    </div>
);

export const AgentActivityPanel: React.FC<AgentActivityPanelProps> = memo(({
    title = 'Agent Activity',
    isProcessing = false,
    error = null,
    onStop,
    headerExtra,
    className = '',
    style,
    children
}) => {
    const listRef = useRef<HTMLDivElement>(null);
    const autoScrollRef = useRef(true);
    const isProgrammaticScrollRef = useRef(false);

    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        if (isProgrammaticScrollRef.current) {
            isProgrammaticScrollRef.current = false;
            return;
        }
        const el = e.currentTarget;
        autoScrollRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) <= 2;
    }, []);

    useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        if (isProcessing) autoScrollRef.current = true;
        if (autoScrollRef.current && el.scrollTop !== el.scrollHeight) {
            isProgrammaticScrollRef.current = true;
            el.scrollTop = el.scrollHeight;
        }
    }, [children, isProcessing]);

    return (
        <div className={className ? `agent-activity-panel-container ${className}` : 'agent-activity-panel-container'} style={style}>
            <div className="agent-panel-header">
                <h3>{title}</h3>
                <div className="header-info">
                    {headerExtra}
                    {isProcessing && onStop && (
                        <button className="stop-button" onClick={onStop}>
                            {STOP_ICON}
                            Stop
                        </button>
                    )}
                </div>
            </div>
            <div className="agent-messages-container custom-scrollbar" ref={listRef} onScroll={handleScroll}>
                {children}
                {isProcessing && PROCESSING_INDICATOR}
            </div>
            {error && (
                <div className="error-message">
                    {WARNING_ICON}
                    {error}
                </div>
            )}
        </div>
    );
});

type TraceToolCall = { id?: string; name?: string; args?: unknown };

function traceContentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content, null, 2);
    return content.map(part => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const rec = part as Record<string, unknown>;
        return typeof rec.text === 'string' ? rec.text : typeof rec.redacted === 'string' ? rec.redacted : '';
    }).filter(Boolean).join('\n').trim();
}

function toolResultContent(message: SandboxToolExecutionTraceMessage, content: string): string {
    const output = `<!-- EXECUTION_OUTPUT_START -->\n\`\`\`\n${content}\n\`\`\`\n<!-- EXECUTION_OUTPUT_END -->`;
    const images = (message.images || []).map(img => `![${img.filename.replace(/[\]\n\r]/g, ' ')}](${img.url})`).join('\n\n');
    return images ? `${output}\n\n${images}` : output;
}

function activityMessages(executionTraceText?: string): AdaptiveMessage[] {
    if (!executionTraceText) return [];
    let trace: SandboxToolExecutionTrace;
    try {
        trace = JSON.parse(executionTraceText) as SandboxToolExecutionTrace;
    } catch {
        return [];
    }
    if (trace.schema !== 'sandbox_tool_execution_trace.v1' || !Array.isArray(trace.messages)) return [];

    const toolResults = new Set(trace.messages.filter(m => m.role === 'tool' && m.tool_call_id).map(m => m.tool_call_id));
    const activity: AdaptiveMessage[] = [];

    trace.messages.forEach((message, index) => {
        const id = message.id || `sandbox-activity-${index}`;
        const content = traceContentText(message.content);

        if (message.role === 'assistant') {
            const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(c => !!c && typeof c === 'object') as TraceToolCall[] : [];
            const segments: ResponseSegment[] = [];
            if (content) segments.push({ kind: 'text', text: content });
            calls.forEach(call => {
                const name = call.name || 'tool';
                segments.push({ kind: 'tool', tool: { type: `${name}()`, rawType: name, args: call.args } });
            });
            if (segments.length) {
                activity.push({ id, role: 'agent', sender: trace.agent.name, content, timestamp: index, status: 'success', segments });
            }
            calls.forEach(call => {
                if ((call.name === 'final_output' || call.name === 'submit_final_output') && (!call.id || !toolResults.has(call.id))) {
                    activity.push({
                        id: `${id}-submitted`,
                        role: 'system',
                        content: 'Submitted',
                        timestamp: index,
                        status: 'success',
                        blocks: [{ kind: 'tool_result', tool: call.name, result: 'Submitted' }],
                    });
                }
            });
            return;
        }

        if (message.role === 'tool') {
            const tool = message.name || 'tool';
            const isError = message.status === 'error';
            const isFinalOutput = tool === 'final_output' || tool === 'submit_final_output';
            const blocks: SystemBlock[] = isError && isFinalOutput
                ? [{ kind: 'error', message: content }]
                : isFinalOutput
                    ? [{ kind: 'tool_result', tool, result: 'Submitted' }]
                    : [{ kind: 'tool_result', tool, result: toolResultContent(message, content) }];
            activity.push({ id, role: 'system', content, timestamp: index, status: isError ? 'error' : 'success', blocks });
            return;
        }

        if (content) {
            activity.push({ id, role: 'system', content, timestamp: index, status: 'success' });
        }
    });

    return activity;
}

export const SandboxAgentActivity: React.FC<{ executionTraceText?: string; headerExtra?: React.ReactNode }> = ({ executionTraceText, headerExtra }) => {
    const messages = useMemo(() => activityMessages(executionTraceText), [executionTraceText]);
    return (
        <AgentActivityPanel title="Agent Activity" headerExtra={headerExtra} className="deepthink-sandbox-activity">
            {messages.length
                ? messages.map(m => <MessageCard key={m.id} message={m} />)
                : <div className="timeline-empty">No sandbox activity is available for this response.</div>}
        </AgentActivityPanel>
    );
};