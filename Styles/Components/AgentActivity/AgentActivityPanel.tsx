import React, { useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { Icon } from '../../../UI/Icons';
import RenderMathMarkdown from '../RenderMathMarkdown';
import type { SandboxToolExecutionTrace, SandboxToolExecutionTraceMessage } from '../../../Core/SandboxToolRuntime';

export type ResponseSegment =
    | { kind: 'text'; text: string }
    | { kind: 'tool'; tool: { type: string; rawType?: string; args?: any } };

export type SystemBlock =
    | { kind: 'error'; message: string }
    | { kind: 'info'; message: string }
    | { kind: 'tool_result'; tool: string; result: string };

export interface ActivityMessage {
    id: string;
    role: 'agent' | 'system';
    sender?: string;
    content: string;
    timestamp: number;
    status?: 'processing' | 'success' | 'error';
    segments?: ResponseSegment[];
    blocks?: SystemBlock[];
}

const TOOL_METADATA: Record<string, { icon: string; name: string }> = {
    sandbox_exec: { icon: 'terminal', name: 'Running sandbox command' },
    shared_workspace: { icon: 'description', name: 'Updating shared workspace' },
    final_output: { icon: 'check_circle', name: 'Submitting final output' }
};

const ToolArgumentsCard: React.FC<{ toolName: string; args?: any }> = ({ toolName, args }) => {
    if (!args) return null;

    if (toolName === 'sandbox_exec' && args.command) {
        return (
            <div className="tool-arguments-card">
                <div className="tool-args-details">
                    <div className="tool-args-row">
                        <span className="tool-args-label">Command:</span>
                        <code className="tool-args-code">{args.command}</code>
                    </div>
                </div>
            </div>
        );
    }

    if (toolName === 'shared_workspace') {
        return (
            <div className="tool-arguments-card">
                <div className="tool-args-details">
                    <div className="tool-args-row">
                        <span className="tool-args-label">Action:</span>
                        <code className="tool-args-code">{args.action || 'read'}</code>
                    </div>
                </div>
            </div>
        );
    }

    if (toolName === 'final_output' && typeof args.response === 'string' && args.response.trim()) {
        return (
            <div className="submitted-artifact-surface">
                <RenderMathMarkdown content={args.response} />
            </div>
        );
    }

    return null;
};

const ToolCallCard: React.FC<{ toolCall: { type: string; rawType?: string; args?: any } }> = ({ toolCall }) => {
    const toolName = toolCall.rawType || toolCall.type.replace('()', '');
    const info = TOOL_METADATA[toolName] || { icon: 'build', name: toolName };
    const parameterSummary = toolName === 'sandbox_exec' && typeof toolCall.args?.command === 'string'
        ? toolCall.args.command
        : toolName === 'shared_workspace' && typeof toolCall.args?.action === 'string'
            ? toolCall.args.action
            : null;
    const hideGenericArgsCard = (toolName === 'sandbox_exec' || toolName === 'shared_workspace') && Boolean(parameterSummary);

    return (
        <div className="tool-call-container">
            <div className="tool-call-display">
                <div className="tool-call-indicator deepthink-tool-indicator">
                    <Icon name={info.icon} className="tool-indicator-icon" />
                    <span className="tool-name">{info.name}</span>
                </div>
                {parameterSummary && (
                    <span className="tool-call-parameter-pill">{parameterSummary}</span>
                )}
            </div>
            {!hideGenericArgsCard && <ToolArgumentsCard toolName={toolName} args={toolCall.args} />}
        </div>
    );
};

const ToolResultDisplay: React.FC<{ tool: string; result: string }> = ({ tool, result }) => {
    if (result === 'Submitted') {
        return (
            <div className="system-block success">
                <Icon name="check_circle" className="block-icon" />
                <span>Final output submitted</span>
            </div>
        );
    }

    const isSandboxTool = tool === 'sandbox_exec' || tool === 'shared_workspace';
    return (
        <div className={`tool-result ${isSandboxTool ? 'deepthink-agent-result' : ''}`}>
            <div className={`tool-result-header ${isSandboxTool ? 'deepthink-agent-header' : ''}`}>
                {isSandboxTool && (
                    <Icon name={tool === 'shared_workspace' ? 'description' : 'terminal'} className="deepthink-agent-icon" />
                )}
                <span>
                    {tool === 'sandbox_exec'
                        ? 'Command execution output'
                        : tool === 'shared_workspace'
                            ? 'Shared workspace result'
                            : `Result from ${tool}`}
                </span>
            </div>
            <div className="tool-result-content">
                <RenderMathMarkdown content={result} />
            </div>
        </div>
    );
};

const SystemBlockDisplay: React.FC<{ block: SystemBlock }> = ({ block }) => {
    if (block.kind === 'error') {
        return (
            <div className="system-block error">
                <Icon name="error" className="block-icon" />
                <span>{block.message}</span>
            </div>
        );
    }

    if (block.kind === 'info') {
        return (
            <div className="system-block success">
                <Icon name="check_circle" className="block-icon" />
                <span>{block.message}</span>
            </div>
        );
    }

    if (block.kind === 'tool_result') {
        return <ToolResultDisplay tool={block.tool} result={block.result} />;
    }

    return null;
};

export const MessageCard: React.FC<{ message: ActivityMessage }> = memo(({ message }) => {
    const isAgent = message.role === 'agent';

    return (
        <div className={`activity-message-card ${message.role}-message ${message.status || ''}`}>
            {isAgent && message.sender && (
                <div className="message-header">
                    <Icon name="psychology" className="message-icon" />
                    <span className="message-role">{message.sender}</span>
                </div>
            )}

            <div className="message-content">
                {isAgent && message.segments && message.segments.length > 0 ? (
                    <div className="message-inline-content">
                        {message.segments.map((segment, idx) => (
                            segment.kind === 'text' ? (
                                <div key={`text-${idx}`} className="agent-text-segment">
                                    <RenderMathMarkdown content={segment.text} />
                                </div>
                            ) : (
                                <ToolCallCard key={`tool-${idx}`} toolCall={segment.tool} />
                            )
                        ))}
                    </div>
                ) : isAgent && message.content ? (
                    <RenderMathMarkdown content={message.content} />
                ) : null}

                {!isAgent && message.blocks && message.blocks.length > 0 ? (
                    <div className="system-blocks">
                        {message.blocks.map((block, idx) => (
                            <SystemBlockDisplay key={idx} block={block} />
                        ))}
                    </div>
                ) : !isAgent && message.content ? (
                    <RenderMathMarkdown content={message.content} />
                ) : null}
            </div>
        </div>
    );
});

export interface AgentActivityPanelProps {
    title?: string;
    isProcessing?: boolean;
    headerExtra?: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    children?: React.ReactNode;
}

const PROCESSING_INDICATOR = (
    <div className="processing-indicator">
        <div className="spinner" />
        <span>Processing agent response...</span>
    </div>
);

export const AgentActivityPanel: React.FC<AgentActivityPanelProps> = memo(({
    title = 'Agent Activity',
    isProcessing = false,
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
                </div>
            </div>
            <div className="agent-messages-container custom-scrollbar" ref={listRef} onScroll={handleScroll}>
                {children}
                {isProcessing && PROCESSING_INDICATOR}
            </div>
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

function activityMessages(executionTraceText?: string): ActivityMessage[] {
    if (!executionTraceText) return [];
    let trace: SandboxToolExecutionTrace;
    try {
        trace = JSON.parse(executionTraceText) as SandboxToolExecutionTrace;
    } catch {
        return [];
    }
    if (trace.schema !== 'sandbox_tool_execution_trace.v1' || !Array.isArray(trace.messages)) return [];

    const toolResults = new Set(trace.messages.filter(m => m.role === 'tool' && m.tool_call_id).map(m => m.tool_call_id));
    const activity: ActivityMessage[] = [];

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
                if (call.name === 'final_output' && (!call.id || !toolResults.has(call.id))) {
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
            const isFinalOutput = tool === 'final_output';
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