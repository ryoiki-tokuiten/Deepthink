import React, { useState, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import RenderMathMarkdown from '../Styles/Components/RenderMathMarkdown';
import { Icon } from '../UI/Icons';
import { AgentActivityPanel as SharedAgentActivityPanel } from '../Styles/Components/AgentActivity/AgentActivityPanel';
import {
    type AdaptiveDeepthinkStoreState,
    type AdaptiveMessage,
    subscribeToAdaptiveDeepthinkState,
    getAdaptiveDeepthinkState,
    stopAdaptiveDeepthinkProcess,
    updateAdaptiveDeepthinkTab,
    updateAdaptiveDeepthinkStrategyTab
} from './AdaptiveDeepthink';
import {
    createDeepthinkTabContent,
    getVisibleDeepthinkTabs,
    setActiveDeepthinkPipelineForImport,
} from '../Deepthink/ui/Deepthink';

const ADAPTIVE_DEEPTHINK_AGENT_META: Record<string, { displayName: string; icon: string }> = {
    generate_strategies: { displayName: 'Strategy Generation Agent', icon: 'psychology' },
    generate_modules: { displayName: 'Modules Generator Agent', icon: 'science' },
    test_modules: { displayName: 'Modules Testing Agent', icon: 'troubleshoot' },
    execute: { displayName: 'Execution / Critique / Correction', icon: 'settings_suggest' },
    finalize_pass_and_execute: { displayName: 'Finalize Pass / Execute', icon: 'forward' },
    save: { displayName: 'Save Strategy', icon: 'bookmark_added' },
    read_files: { displayName: 'Read Pass Artifacts', icon: 'description' },
    virtual_environment: { displayName: 'Virtual Environment', icon: 'terminal' },
    submit_final_output: { displayName: 'Orchestrator Final Output', icon: 'flag' }
};

const isAdaptiveDeepthinkAgentTool = (toolName: string) => toolName in ADAPTIVE_DEEPTHINK_AGENT_META;
const getAdaptiveDeepthinkAgentDisplayName = (toolName: string) => ADAPTIVE_DEEPTHINK_AGENT_META[toolName]?.displayName ?? toolName;
const getAdaptiveDeepthinkAgentIcon = (toolName: string) => ADAPTIVE_DEEPTHINK_AGENT_META[toolName]?.icon ?? 'smart_toy';

const CollapsibleContent: React.FC<{ content: string; maxLines: number }> = ({ content, maxLines }) => {
    const [expanded, setExpanded] = useState(false);
    const lines = content.split('\n');
    const needsCollapse = lines.length > maxLines;
    const displayContent = expanded || !needsCollapse ? content : lines.slice(0, maxLines).join('\n');

    return (
        <div className="tool-result-content">
            <RenderMathMarkdown content={displayContent} />
            {needsCollapse && (expanded ? (
                <button className="action-btn" onClick={() => setExpanded(false)}>Show less</button>
            ) : (
                <>
                    <div className="content-truncated">... {lines.length - maxLines} more lines ...</div>
                    <button className="action-btn" onClick={() => setExpanded(true)}>Show all</button>
                </>
            ))}
        </div>
    );
};

function getProximityLoopLength(toolName: string, args: unknown): number | null {
    if ((toolName !== 'generate_strategies' && toolName !== 'generate_modules') || !args || typeof args !== 'object') return null;
    const val = (args as any).proximityLoops ?? (args as any).impactReviewLoops;
    return typeof val === 'number' && Number.isInteger(val) ? val : null;
}

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
                                    {replaceIds.map((id: string) => <span key={id} className="tool-args-badge text-accent-red">{id}</span>)}
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
            case 'generate_modules':
                return args.specialContext ? (
                    <div className="tool-args-details">
                        <div className="tool-args-context-block">
                            <span className="tool-args-label">Special Context:</span>
                            <pre className="tool-args-context-text">{args.specialContext}</pre>
                        </div>
                    </div>
                ) : null;
            case 'test_modules': {
                const ids: string[] = args.moduleIds || [];
                return (
                    <div className="tool-args-details">
                        <div className="tool-args-row">
                            <span className="tool-args-label">Modules:</span>
                            <div className="tool-args-badges">
                                {ids.map(id => <span key={id} className="tool-args-badge text-accent-purple">{id}</span>)}
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
            case 'save':
            case 'final_output':
            case 'submit_final_output':
                return null;
            case 'read_files': {
                const paths: string[] = args.paths || [];
                return (
                    <div className="tool-args-details">
                        <div className="tool-args-row">
                            <span className="tool-args-label">Read files:</span>
                            <div className="tool-args-badges">
                                {paths.map(p => (
                                    <span key={p} className="tool-args-badge text-accent-orange" title={p}>{p.split('/').pop() || p}</span>
                                ))}
                            </div>
                        </div>
                    </div>
                );
            }
            case 'virtual_environment':
                return (
                    <div className="tool-args-details">
                        <div className="tool-args-row">
                            <span className="tool-args-label">Command:</span>
                            <code className="tool-args-code">{args.command}</code>
                        </div>
                    </div>
                );
            case 'sandbox_exec':
                return (
                    <div className="tool-args-details">
                        <div className="tool-args-context-block">
                            <span className="tool-args-label">Command</span>
                            <pre className="tool-args-context-text">{String(args.command || '')}</pre>
                        </div>
                    </div>
                );
            default:
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
    };

    const details = renderDetails();
    return details ? <div className="tool-arguments-card">{details}</div> : null;
};

export type { AdaptiveMessage, ResponseSegment, SystemBlock } from './AdaptiveDeepthink';

export const MessageCard: React.FC<{ message: AdaptiveMessage }> = ({ message }) => {
    const iconName = message.role === 'agent' ? 'smart_toy' : message.role === 'system' ? (message.status === 'error' ? 'warning' : 'terminal') : 'person';
    const baseClass = `adaptive-message-card ${message.role === 'system' ? (message.status === 'error' ? 'system-error' : 'system-success') : `${message.role}-message`}`;

    return (
        <div className={baseClass}>
            <div className="message-header">
                <div className="message-avatar"><Icon name={iconName} /></div>
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
                    <div className="message-inline-content">
                        {message.segments.map((segment, idx) => {
                            if (segment.kind === 'text') {
                                return <div key={`seg-${idx}`} className="agent-text-segment"><RenderMathMarkdown content={segment.text} /></div>;
                            }
                            const { tool } = segment;
                            const rawToolType = tool.rawType;
                            const isDeepthinkTool = !!rawToolType && isAdaptiveDeepthinkAgentTool(rawToolType);
                            const agentIcon = rawToolType ? getAdaptiveDeepthinkAgentIcon(rawToolType) : 'smart_toy';
                            const proximityLoopLength = getProximityLoopLength(rawToolType || tool.type, tool.args);
                            return (
                                <div key={`seg-${idx}`} className="tool-segment-wrapper">
                                    <div className="tool-call-display">
                                        <div className={`tool-call-indicator ${isDeepthinkTool ? 'deepthink-tool-indicator' : ''}`}>
                                            {isDeepthinkTool && agentIcon && <Icon name={agentIcon} className="tool-indicator-icon" />}
                                            <span className="tool-name">{tool.type}</span>
                                        </div>
                                        {proximityLoopLength !== null && <span className="tool-call-parameter-pill">proximity-loop-length={proximityLoopLength}</span>}
                                    </div>
                                    <ToolArgumentsCard toolName={rawToolType || tool.type} args={tool.args} />
                                </div>
                            );
                        })}
                    </div>
                ) : message.role === 'system' && message.blocks ? (
                    <div className="system-blocks">
                        {message.blocks.map((block, idx) => {
                            if (block.kind === 'error') {
                                return (
                                    <div key={`block-${idx}`} className="system-block error">
                                        <Icon name="warning" className="block-icon" />
                                        <span>{block.message}</span>
                                    </div>
                                );
                            }
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
                                return <CollapsibleContent key={`block-${idx}`} content={block.result} maxLines={30} />;
                            }
                            const toolDisplay = block.tool.endsWith('()') ? block.tool : `${block.tool}()`;
                            return (
                                <div key={`block-${idx}`} className="tool-result">
                                    <div className="tool-result-header">Tool Result: {toolDisplay}</div>
                                    <CollapsibleContent content={block.result} maxLines={30} />
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <RenderMathMarkdown content={message.content} />
                )}
            </div>
        </div>
    );
};

let adaptiveDeepthinkRoot: Root | null = null;

const DeepthinkEmbeddedPanel: React.FC<{ state: AdaptiveDeepthinkStoreState }> = ({ state }) => {
    const pipelineState = state.deepthinkPipelineState;
    const currentTab = state.navigationState.currentTab;
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => document.getElementById('controls-sidebar')?.classList.contains('collapsed') ?? false);

    setActiveDeepthinkPipelineForImport(pipelineState);
    if (pipelineState.activeTabId !== currentTab) pipelineState.activeTabId = currentTab;

    const allTabs = getVisibleDeepthinkTabs(pipelineState);
    const preferredTabId = currentTab === 'critique-history' ? 'modules-explorer' : currentTab;
    const activeTabId = allTabs.some(tab => tab.id === preferredTabId) ? preferredTabId : (allTabs[0]?.id || 'live');
    pipelineState.activeTabId = activeTabId;
    const deepthinkContent = createDeepthinkTabContent(pipelineState, {
        onStrategyTabClick: updateAdaptiveDeepthinkStrategyTab,
        hideStopButton: true
    });

    useEffect(() => {
        if (activeTabId !== currentTab) updateAdaptiveDeepthinkTab(activeTabId);
    }, [activeTabId, currentTab]);

    useEffect(() => {
        const sidebar = document.getElementById('controls-sidebar');
        if (!sidebar) { setIsSidebarCollapsed(false); return; }
        const sync = () => setIsSidebarCollapsed(sidebar.classList.contains('collapsed'));
        sync();
        const observer = new MutationObserver(sync);
        observer.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    return (
        <div className="adaptive-deepthink-embedded-panel">
            <div className="tabs-nav-container">
                {isSidebarCollapsed && (
                    <button
                        className="tab-button deepthink-mode-tab sidebar-toggle-button"
                        onClick={() => {
                            const sidebar = document.getElementById('controls-sidebar');
                            if (sidebar) {
                                sidebar.classList.toggle('collapsed');
                                setIsSidebarCollapsed(sidebar.classList.contains('collapsed'));
                            }
                        }}
                        title="Expand Sidebar"
                    >
                        <Icon name="dock_to_right" />
                    </button>
                )}
                {allTabs.map(tab => (
                    <button
                        key={tab.id}
                        id={`deepthink-tab-${tab.id}`}
                        className={`tab-button deepthink-mode-tab ${activeTabId === tab.id ? 'active' : ''} ${tab.statusClass} ${tab.alignRight ? 'align-right' : ''}`}
                        onClick={() => {
                            updateAdaptiveDeepthinkTab(tab.id);
                            if (tab.id === 'live') window.dispatchEvent(new CustomEvent('deepthinkLiveTabOpened'));
                        }}
                    >
                        <Icon name={tab.icon} />
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className="pipelines-content-container">{deepthinkContent}</div>
        </div>
    );
};

const AdaptiveDeepthinkUIView: React.FC = () => {
    const [state, setState] = useState<AdaptiveDeepthinkStoreState | null>(getAdaptiveDeepthinkState());
    useEffect(() => {
        const unsub = subscribeToAdaptiveDeepthinkState(setState);
        return () => { unsub(); };
    }, []);

    if (!state) return null;

    return (
        <div className="adaptive-deepthink-ui-container">
            <DeepthinkEmbeddedPanel state={state} />
            <div className="adaptive-deepthink-agent-panel-wrapper">
                <SharedAgentActivityPanel
                    title="Agent Activity"
                    isProcessing={state.isProcessing}
                    error={state.error}
                    onStop={stopAdaptiveDeepthinkProcess}
                    headerExtra={state.isComplete && <span className="status-badge status-completed">Completed</span>}
                    className="adaptive-agent-panel"
                >
                    {state.messages.map((message, index) => (
                        <MessageCard key={message.id || `idx-${index}`} message={message} />
                    ))}
                </SharedAgentActivityPanel>
            </div>
        </div>
    );
};

export function renderAdaptiveDeepthinkMode() {
    const container = document.getElementById('pipelines-content-container');
    const tabsContainer = document.getElementById('tabs-nav-container');
    const mainHeaderContent = document.querySelector('.main-header-content') as HTMLElement | null;
    if (!container || !tabsContainer) return;

    if (adaptiveDeepthinkRoot) {
        adaptiveDeepthinkRoot.unmount();
        adaptiveDeepthinkRoot = null;
    }

    tabsContainer.innerHTML = '';
    container.innerHTML = '';
    if (mainHeaderContent) mainHeaderContent.style.display = 'none';
    container.style.height = '100%';
    container.style.overflow = 'hidden';
    container.style.padding = '0';

    const adaptiveContainer = document.createElement('div');
    adaptiveContainer.id = 'adaptive-deepthink-container';
    adaptiveContainer.className = 'pipeline-content active';
    adaptiveContainer.style.height = '100%';
    adaptiveContainer.style.display = 'flex';
    adaptiveContainer.style.flexDirection = 'column';
    container.appendChild(adaptiveContainer);

    adaptiveDeepthinkRoot = createRoot(adaptiveContainer);
    adaptiveDeepthinkRoot.render(<AdaptiveDeepthinkUIView />);
}

export {
    startAdaptiveDeepthinkProcess,
    stopAdaptiveDeepthinkProcess,
    cleanupAdaptiveDeepthinkMode,
    getAdaptiveDeepthinkState,
    setAdaptiveDeepthinkStateForImport
} from './AdaptiveDeepthink';
