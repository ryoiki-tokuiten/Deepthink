/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AdaptiveMessage } from './AdaptiveTypes';
import RenderMathMarkdown from '../Styles/Components/RenderMathMarkdown';
import {
    getAdaptiveDeepthinkAgentDisplayName,
    getAdaptiveDeepthinkAgentIcon,
    isAdaptiveDeepthinkAgentTool
} from './AdaptiveDeepthinkAgentMeta';
import { Icon } from '../UI/Icons';
import { AgentActivityPanel as SharedAgentActivityPanel } from '../Styles/Components/AgentActivity/AgentActivityPanel';


// Collapsible content component for large outputs
const CollapsibleContent: React.FC<{ content: string; maxLines: number }> = ({ content, maxLines }) => {
    const [expanded, setExpanded] = React.useState(false);
    const lines = content.split('\n');
    const needsCollapse = lines.length > maxLines;

    const displayContent = expanded || !needsCollapse
        ? content
        : lines.slice(0, maxLines).join('\n');

    return (
        <div className="tool-result-content">
            <RenderMathMarkdown content={displayContent} />
            {needsCollapse && (expanded ? (
                <button className="action-btn" onClick={() => setExpanded(false)}>
                    Show less
                </button>
            ) : (
                <>
                    <div className="content-truncated">... {lines.length - maxLines} more lines ...</div>
                    <button className="action-btn" onClick={() => setExpanded(true)}>
                        Show all
                    </button>
                </>
            ))}
        </div>
    );
};

function getProximityLoopLength(toolName: string, args: unknown): number | null {
    if (toolName !== 'generate_strategies' && toolName !== 'generate_modules') return null;
    if (!args || typeof args !== 'object') return null;
    const value = (args as { proximityLoops?: unknown; impactReviewLoops?: unknown }).proximityLoops
        ?? (args as { impactReviewLoops?: unknown }).impactReviewLoops;
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

// Component for displaying tool arguments visually
const ToolArgumentsCard: React.FC<{ toolName: string; args?: any }> = ({ toolName, args }) => {
    if (!args || typeof args !== 'object' || Object.keys(args).length === 0) return null;

    const renderDetails = () => {
        switch (toolName) {
            case 'generate_strategies': {
                const replaceIds = args.replaceStrategyIds || [];
                if (replaceIds.length === 0 && !args.specialContext) return null;
                return (
                    <div className="tool-args-details">
                        {replaceIds.length > 0 && (
                            <div className="tool-args-row">
                                <span className="tool-args-label">Replace:</span>
                                <div className="tool-args-badges">
                                    {replaceIds.map((id: string) => (
                                        <span key={id} className="tool-args-badge text-accent-red">{id}</span>
                                    ))}
                                </div>
                            </div>
                        )}
                        {args.specialContext && (
                            <div className="tool-args-context-block">
                                <span className="tool-args-label">Special Context:</span>
                                <pre className="tool-args-context-text">{args.specialContext}</pre>
                            </div>
                        )}
                    </div>
                );
            }
            case 'generate_modules': {
                if (!args.specialContext) return null;
                return (
                    <div className="tool-args-details">
                        <div className="tool-args-context-block">
                            <span className="tool-args-label">Special Context:</span>
                            <pre className="tool-args-context-text">{args.specialContext}</pre>
                        </div>
                    </div>
                );
            }
            case 'test_modules': {
                const ids: string[] = args.moduleIds || [];
                return (
                    <div className="tool-args-details">
                        <div className="tool-args-row">
                            <span className="tool-args-label">Modules:</span>
                            <div className="tool-args-badges">
                                {ids.map(id => (
                                    <span key={id} className="tool-args-badge text-accent-purple">{id}</span>
                                ))}
                            </div>
                        </div>
                    </div>
                );
            }
            case 'execute':
            case 'finalize_pass_and_execute': {
                const executions: Array<{ strategyId: string; specialContext?: string; context?: string }> = args.executions || [];
                return (
                    <div className="tool-args-details">
                        {args.specialContext && (
                            <div className="tool-args-context-block" style={{ marginBottom: '12px' }}>
                                <span className="tool-args-label">Global Special Context:</span>
                                <pre className="tool-args-context-text">{args.specialContext}</pre>
                            </div>
                        )}
                        <div className="tool-args-executions">
                            {executions.map((exec, idx) => (
                                <div key={idx} className="tool-args-exec-item">
                                    <div className="tool-args-row">
                                        <span className="tool-args-label">Strategy:</span>
                                        <span className="tool-args-badge text-accent-blue">{exec.strategyId}</span>
                                    </div>
                                    {(exec.context || exec.specialContext) && (
                                        <div className="tool-args-context-block">
                                            <span className="tool-args-label">Context:</span>
                                            <pre className="tool-args-context-text">{exec.context || exec.specialContext}</pre>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                );
            }
            case 'save': {
                return null;
            }
            case 'read_files': {
                const paths: string[] = args.paths || [];
                return (
                    <div className="tool-args-details">
                        <div className="tool-args-row">
                            <span className="tool-args-label">Read files:</span>
                            <div className="tool-args-badges">
                                {paths.map(p => {
                                    const parts = p.split('/');
                                    const name = parts[parts.length - 1] || p;
                                    return (
                                        <span key={p} className="tool-args-badge text-accent-orange" title={p}>{name}</span>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                );
            }
            case 'virtual_environment': {
                return (
                    <div className="tool-args-details">
                        <div className="tool-args-row">
                            <span className="tool-args-label">Command:</span>
                            <code className="tool-args-code">{args.command}</code>
                        </div>
                    </div>
                );
            }
            case 'sandbox_exec': {
                return (
                    <div className="tool-args-details">
                        <div className="tool-args-context-block">
                            <span className="tool-args-label">Command</span>
                            <pre className="tool-args-context-text">{String(args.command || '')}</pre>
                        </div>
                    </div>
                );
            }
            case 'final_output':
            case 'submit_final_output': {
                return null;
            }
            default: {
                return (
                    <div className="tool-args-details">
                        {Object.entries(args).map(([key, val]) => (
                            <div key={key} className="tool-args-row">
                                <span className="tool-args-label">{key}:</span>
                                <span className="tool-args-value">{JSON.stringify(val)}</span>
                            </div>
                        ))}
                    </div>
                );
            }
        }
    };

    const details = renderDetails();
    if (!details) return null;

    return (
        <div className="tool-arguments-card">
            {details}
        </div>
    );
};

// Component for rendering a single message
export const MessageCard: React.FC<{ message: AdaptiveMessage }> = ({ message }) => {
    const getMessageIcon = () => {
        switch (message.role) {
            case 'agent': return <Icon name="smart_toy" />;
            case 'system': return message.status === 'error' ? <Icon name="warning" /> : <Icon name="terminal" />;
            case 'user': return <Icon name="person" />;
            default: return <Icon name="person" />;
        }
    };

    const getMessageClass = () => {
        let baseClass = 'adaptive-message-card';
        if (message.role === 'system') {
            baseClass += message.status === 'error' ? ' system-error' : ' system-success';
        } else {
            baseClass += ` ${message.role}-message`;
        }
        return baseClass;
    };

    // Render segments for agent messages
    const renderSegments = () => {
        if (!message.segments) return null;

        return (
            <div className="message-inline-content">
                {message.segments.map((segment, idx) => {
                    if (segment.kind === 'text') {
                        return (
                            <div key={`seg-${idx}`} className="agent-text-segment">
                                <RenderMathMarkdown content={segment.text} />
                            </div>
                        );
                    } else if (segment.kind === 'tool') {
                        const tool = (segment as any).tool;
                        const toolType = tool.type;
                        const rawToolType = tool.rawType;
                        const isDeepthinkTool = !!rawToolType && isAdaptiveDeepthinkAgentTool(rawToolType);
                        const agentIcon = rawToolType ? getAdaptiveDeepthinkAgentIcon(rawToolType) : 'smart_toy';
                        const proximityLoopLength = getProximityLoopLength(rawToolType || toolType, tool.args);

                        return (
                            <div key={`seg-${idx}`} className="tool-segment-wrapper">
                                <div className="tool-call-display">
                                    <div className={`tool-call-indicator ${isDeepthinkTool ? 'deepthink-tool-indicator' : ''}`}>
                                        {isDeepthinkTool && agentIcon && (
                                            <Icon name={agentIcon} className="tool-indicator-icon" />
                                        )}
                                        <span className="tool-name">{toolType}</span>
                                    </div>
                                    {proximityLoopLength !== null && (
                                        <span className="tool-call-parameter-pill">
                                            proximity-loop-length={proximityLoopLength}
                                        </span>
                                    )}
                                </div>
                                <ToolArgumentsCard toolName={rawToolType || toolType} args={tool.args} />
                            </div>
                        );
                    }
                    return null;
                })}
            </div>
        );
    };

    // Render system blocks (structured system messages)
    const renderSystemBlocks = () => {
        if (!message.blocks) return null;

        return (
            <div className="system-blocks">
                {message.blocks.map((block, idx) => {
                    if (block.kind === 'error') {
                        return (
                            <div key={`block-${idx}`} className="system-block error">
                                <Icon name="warning" className="block-icon" />
                                <span>{block.message}</span>
                            </div>
                        );
                    } else if (block.kind === 'tool_result') {
                        if ((block.tool === 'final_output' || block.tool === 'submit_final_output') && block.result === 'Submitted') {
                            return (
                                <div key={`block-${idx}`} className="system-block success">
                                    <Icon name="check_circle" className="block-icon" />
                                    <span>Submitted</span>
                                </div>
                            );
                        }
                        if (isAdaptiveDeepthinkAgentTool(block.tool)) {
                            return (
                                <div key={`block-${idx}`} className="tool-result deepthink-agent-result concise">
                                    <div className="tool-result-header deepthink-agent-header">
                                        <Icon name="verified_user" className="deepthink-agent-icon" />
                                        <span>{getAdaptiveDeepthinkAgentDisplayName(block.tool)} completed</span>
                                    </div>
                                    <div className="tool-result-summary">
                                        <CollapsibleContent content={block.result} maxLines={30} />
                                    </div>
                                </div>
                            );
                        }

                        if (block.tool === 'sandbox_exec' || block.tool === 'sandbox_exec()') {
                            return (
                                <CollapsibleContent key={`block-${idx}`} content={block.result} maxLines={30} />
                            );
                        }

                        const toolDisplay = block.tool.endsWith('()') ? block.tool : `${block.tool}()`;
                        return (
                            <div key={`block-${idx}`} className="tool-result">
                                <div className="tool-result-header">Tool Result: {toolDisplay}</div>
                                <CollapsibleContent content={block.result} maxLines={30} />
                            </div>
                        );
                    }
                    return null;
                })}
            </div>
        );
    };

    return (
        <div className={getMessageClass()}>
            <div className="message-header">
                <div className="message-avatar">
                    {getMessageIcon()}
                </div>
                <div className="message-sender-info">
                    <span className="message-sender">
                        {message.sender || (message.role === 'agent'
                            ? (message.segments?.[0]?.kind === 'tool' ? getAdaptiveDeepthinkAgentDisplayName(message.segments[0].tool.rawType || message.segments[0].tool.type) : 'Orchestrator')
                            : 'Environment Output')}
                    </span>
                </div>
            </div>
            <div className="message-content">
                {message.role === 'agent' && message.segments ? (
                    renderSegments()
                ) : message.role === 'system' && message.blocks ? (
                    renderSystemBlocks()
                ) : (
                    <RenderMathMarkdown content={message.content} />
                )}
            </div>
        </div>
    );
};

// Component for the right panel showing agent activity
interface AgentActivityPanelProps {
    messages: AdaptiveMessage[];
    isProcessing: boolean;
    isComplete: boolean;
    error?: string;
    onStop?: () => void;
}

export const AgentActivityPanel: React.FC<AgentActivityPanelProps> = ({ messages, isProcessing, isComplete, error, onStop }) => {
    return (
        <SharedAgentActivityPanel
            title="Agent Activity"
            isProcessing={isProcessing}
            error={error}
            onStop={onStop}
            headerExtra={isComplete && <span className="status-badge status-completed">Completed</span>}
            className="adaptive-agent-panel"
        >
            {messages.map((message, index) => (
                <MessageCard key={message.id || `idx-${index}`} message={message} />
            ))}
        </SharedAgentActivityPanel>
    );
};
