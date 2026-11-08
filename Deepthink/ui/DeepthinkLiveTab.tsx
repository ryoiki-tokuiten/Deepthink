import React, { useEffect, useState, useRef } from 'react';
import { DeepthinkPipelineState, DeepthinkLiveEvent } from '../core/deepthinkCore';
import { Icon as MIcon } from '../../UI/Icons';
import { ActionButton } from '../../Styles/Components/ActionButton';
import RenderMathMarkdown from '../../Styles/Components/RenderMathMarkdown';
import { SandboxAgentActivity } from '../../Styles/Components/AgentActivity/AgentActivityPanel';

interface DeepthinkLiveTabProps {
    process: DeepthinkPipelineState;
}

export const DeepthinkLiveTab: React.FC<DeepthinkLiveTabProps> = ({ process }) => {
    const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
    const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
    const [filterType, setFilterType] = useState<'all' | 'agents' | 'info' | 'errors'>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [timeElapsed, setTimeElapsed] = useState('00:00');
    const [isSystemInstructionExpanded, setIsSystemInstructionExpanded] = useState(false);
    const [responseViewMode, setResponseViewMode] = useState<'submitted' | 'activity'>('submitted');
    const [isUserSelected, setIsUserSelected] = useState(false);

    const terminalEndRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const startTimeRef = useRef<number>(Date.now());

    useEffect(() => {
        setSelectedEventId(null);
        setSelectedAgentName(null);
        setIsUserSelected(false);
    }, [process.id]);

    useEffect(() => {
        const formatDuration = (ms: number) => {
            const totalSecs = Math.floor(ms / 1000);
            const secs = (totalSecs % 60).toString().padStart(2, '0');
            const mins = (Math.floor(totalSecs / 60) % 60).toString().padStart(2, '0');
            return `${mins}:${secs}`;
        };

        if (process.status === 'processing') {
            startTimeRef.current = process.liveEvents?.[0]?.timestamp ?? Date.now();
            const updateTimer = () => setTimeElapsed(formatDuration(Date.now() - startTimeRef.current));
            updateTimer();
            timerRef.current = setInterval(updateTimer, 1000);
        } else {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
            const events = process.liveEvents || [];
            setTimeElapsed(events.length > 1 ? formatDuration(events[events.length - 1].timestamp - events[0].timestamp) : '00:00');
        }
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, [process.status, process.liveEvents?.length]);

    useEffect(() => {
        const handleLiveTabOpened = () => setIsUserSelected(false);
        window.addEventListener('deepthinkLiveTabOpened', handleLiveTabOpened);
        return () => window.removeEventListener('deepthinkLiveTabOpened', handleLiveTabOpened);
    }, []);

    useEffect(() => {
        terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [process.liveEvents?.length]);

    const events = process.liveEvents || [];

    useEffect(() => {
        if (isUserSelected) return;
        const lastAgentEvent = [...events].reverse().find(ev =>
            !!ev.agentName && (ev.eventType === 'agent_start' || ev.eventType === 'agent_complete' || ev.eventType === 'agent_retry' || ev.eventType === 'agent_error')
        );
        if (!lastAgentEvent) return;
        setSelectedEventId(lastAgentEvent.id);
        setSelectedAgentName(lastAgentEvent.executionId || lastAgentEvent.agentName);
    }, [process.id, process.liveEvents?.length, isUserSelected]);

    const getAgentCategory = (agentName: string, stepDescription: string): string => {
        const text = `${agentName || ''} ${stepDescription || ''}`.toLowerCase();
        if (text.includes('bsr') || text.includes('branch state')) return 'redteam';
        if (text.includes('dos') || text.includes('synthesis') || text.includes('critique') || text.includes('critic')) return 'critique';
        if (text.includes('correction')) return 'correction';
        if (text.includes('memory')) return 'strategy';
        if (text.includes('modules') || text.includes('tester')) return 'modules';
        if (text.includes('strategy') || text.includes('attempt') || text.includes('execution') || text.includes('solver') || text.includes('proximity')) return 'strategy';
        return 'general';
    };

    const formatAgentName = (agentName: string, stepDescription: string): string => {
        if (!agentName) return '';
        const desc = stepDescription || '';
        const lowerName = agentName.toLowerCase();
        const meta = desc.match(/\(([^)]+)\)/)?.[1] || '';
        const target = desc.match(/for\s+([a-zA-Z0-9_-]+)/i)?.[1] || '';
        const withParts = (base: string, parts: string[]) => {
            const filtered = parts.filter(Boolean);
            return filtered.length > 0 ? `${base} (${filtered.join(', ')})` : base;
        };

        if (lowerName.includes('solution attempt')) return withParts('Initial Execution', [target, meta]);
        if (lowerName.includes('solution correction')) return withParts('Correction Agent', [target, meta]);
        if (lowerName.includes('solution critique')) return withParts('Critique Agent', [target, meta]);
        if (lowerName.includes('dissected observations') || lowerName.includes('synthesis')) {
            const prefix = desc.toLowerCase().includes('step-i') ? 'step-i, For ' : 'For ';
            return meta ? `Dissected Observations Synthesis Agent (${prefix}${meta})` : 'Dissected Observations Synthesis Agent';
        }
        if (lowerName.includes('branch state')) return withParts('Branch State Representation Agent', [target, meta]);
        if (lowerName.includes('memory bank')) return withParts('Memory Bank Agent', [target, meta]);
        if (lowerName.includes('modules testing')) return withParts('Modules Testing Agent', [desc.match(/\b(m\d+)\b/i)?.[1] || '', meta]);
        if (lowerName.includes('modules generation') || lowerName.includes('modules generator')) return withParts('Modules Generator Agent', [meta]);
        if (lowerName.includes('modules impact review') || lowerName.includes('modules impact reviewer')) return withParts('Modules Impact Reviewer Agent', [meta]);
        return meta ? `${agentName} (${meta})` : agentName;
    };

    const filteredEvents = events.filter(ev => {
        if (filterType === 'agents' && !['agent_start', 'agent_complete', 'agent_error', 'agent_retry'].includes(ev.eventType)) return false;
        if (filterType === 'info' && ev.eventType !== 'info') return false;
        if (filterType === 'errors' && ev.eventType !== 'agent_error') return false;
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            return ev.agentName.toLowerCase().includes(q) ||
                ev.stepDescription.toLowerCase().includes(q) ||
                !!ev.prompt?.toLowerCase().includes(q) ||
                !!ev.response?.toLowerCase().includes(q) ||
                !!ev.error?.toLowerCase().includes(q);
        }
        return true;
    });

    const agentEventsMap = new Map<string, DeepthinkLiveEvent>();
    events.forEach(ev => {
        if (ev.agentName && ['agent_start', 'agent_complete', 'agent_error', 'agent_retry'].includes(ev.eventType)) {
            agentEventsMap.set(ev.executionId || ev.agentName, ev);
        }
    });
    const allTimelineAgents = Array.from(agentEventsMap.values());

    const selectedEventById = selectedEventId ? events.find(ev => ev.id === selectedEventId) : undefined;
    let selectedEvent = selectedAgentName ? agentEventsMap.get(selectedAgentName) || selectedEventById : selectedEventById;
    if (!selectedEvent && !selectedAgentName && allTimelineAgents[0]?.agentName) {
        selectedEvent = agentEventsMap.get(allTimelineAgents[0].executionId || allTimelineAgents[0].agentName);
    }
    if (!selectedEvent) selectedEvent = events[events.length - 1];

    const selectedPromptEvent = (selectedEvent?.executionId
        ? events.find(ev => ev.executionId === selectedEvent?.executionId && ev.eventType === 'agent_start')
        : undefined) || selectedEvent;

    const selectEvent = (ev: DeepthinkLiveEvent) => {
        setSelectedEventId(ev.id);
        setSelectedAgentName(ev.executionId || ev.agentName || null);
        setIsUserSelected(true);
    };

    useEffect(() => {
        setResponseViewMode('submitted');
    }, [selectedEvent?.id]);

    const responseViewToggle = selectedEvent?.executionTraceText && (
        <div className="response-view-toggle" aria-label="Response view">
            <button className={`response-toggle-option ${responseViewMode === 'submitted' ? 'active' : ''}`} onClick={() => setResponseViewMode('submitted')}>Artifact</button>
            <button className={`response-toggle-option ${responseViewMode === 'activity' ? 'active' : ''}`} onClick={() => setResponseViewMode('activity')}>Agent Activity</button>
        </div>
    );

    const renderTimelineNode = (agent: DeepthinkLiveEvent) => {
        const isActive = selectedEvent
            ? (selectedEvent.executionId && selectedEvent.executionId === agent.executionId) || (!selectedEvent.executionId && selectedEvent.agentName === agent.agentName)
            : false;
        const category = getAgentCategory(agent.agentName, agent.stepDescription);
        const statusClass = agent.eventType === 'agent_complete' ? 'completed' : (agent.eventType === 'agent_start' || agent.eventType === 'agent_retry') ? 'running' : agent.eventType === 'agent_error' ? 'failed' : 'pending';
        const statusIcon = agent.eventType === 'agent_complete' ? 'check' : (agent.eventType === 'agent_start' || agent.eventType === 'agent_retry') ? 'sync' : agent.eventType === 'agent_error' ? 'error' : 'hourglass_empty';

        return (
            <div key={agent.id} className={`timeline-node ${statusClass} ${isActive ? 'active' : ''} category-${category}`} onClick={() => selectEvent(agent)}>
                <div className="node-connector-line" />
                <div className="node-icon-wrapper"><MIcon name={statusIcon} className="node-status-icon" /></div>
                <div className="node-content" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <div className="node-header">
                        <span className="node-name font-mono">{formatAgentName(agent.agentName, agent.stepDescription)}</span>
                        <span className="node-time font-mono">{new Date(agent.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="deepthink-live-container">
            <div className="live-workspace" style={{ flexDirection: 'row-reverse' }}>
                <div className="live-sidebar">
                    <div className="timeline-header-panel">
                        <div className="timeline-header-row-bottom">
                            <div className={`status-pill status-${process.status === 'stopped' ? 'error' : process.status} compact-status`}>
                                <span className="pulse-indicator" />
                                <span className="status-text">{process.status.toUpperCase()}</span>
                            </div>
                            <div className="duration-pill font-mono">
                                <MIcon name="timer" className="duration-pill-icon" />
                                <span>{timeElapsed}</span>
                            </div>
                            <div className="stat-item" title="Current Loop Iteration / Total Scheduled Iterations">
                                <span className="stat-label">ITERATION:</span>
                                <span className="stat-value font-mono">
                                    {(process.currentIteration ?? (process.dosOutputs?.length ? Math.max(...process.dosOutputs.map(d => d.iteration), 1) : 1))} / {process.runConfig?.i ?? 5}
                                </span>
                            </div>
                            <div style={{ flex: 1 }} />
                        </div>
                    </div>

                    <div className="agent-timeline custom-scrollbar">
                        {allTimelineAgents.length === 0 ? (
                            <div className="timeline-empty">Waiting for agent execution...</div>
                        ) : (
                            (() => {
                                const sortedAgents = [...allTimelineAgents].sort((a, b) => a.timestamp - b.timestamp);
                                const blocks: Array<{ type: 'single'; agent: DeepthinkLiveEvent } | { type: 'group'; id: string; name: string; agents: DeepthinkLiveEvent[] }> = [];
                                sortedAgents.forEach(agent => {
                                    if (agent.executionGroupId) {
                                        const existing = blocks.find(b => b.type === 'group' && b.id === agent.executionGroupId);
                                        if (existing && existing.type === 'group') existing.agents.push(agent);
                                        else blocks.push({ type: 'group', id: agent.executionGroupId, name: agent.executionGroupName || 'Execution Loop', agents: [agent] });
                                    } else {
                                        blocks.push({ type: 'single', agent });
                                    }
                                });
                                return blocks.map(block => {
                                    if (block.type === 'single') return renderTimelineNode(block.agent);
                                    const isRunning = process.status !== 'stopped' && block.agents.some(a => a.eventType === 'agent_start' || a.eventType === 'agent_retry');
                                    return (
                                        <div key={block.id} className={`parallel-active-window ${isRunning ? 'running' : 'completed'}`}>
                                            <div className="parallel-window-header">
                                                <MIcon name={isRunning ? 'sync' : 'check_circle'} className={isRunning ? 'parallel-icon spin' : 'parallel-icon'} style={{ fontSize: '1rem', animation: isRunning ? 'spin 4s linear infinite' : 'none' }} />
                                                <span>{block.name}</span>
                                            </div>
                                            <div className="parallel-window-body">{block.agents.map(renderTimelineNode)}</div>
                                        </div>
                                    );
                                });
                            })()
                        )}
                    </div>
                </div>

                <div className="live-main-content">
                    <div className="live-inspector-panel">
                        <div className="inspector-content">
                            {!selectedEvent ? (
                                <div className="inspector-empty">
                                    <MIcon name="info" className="empty-icon" />
                                    <p>Select an agent in the timeline or logs to inspect its inputs and outputs.</p>
                                </div>
                            ) : selectedEvent.eventType === 'info' ? (
                                <div className="inspector-info-card">
                                    <div className="section-header" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                            <span className="info-icon-badge"><MIcon name="info" /></span>
                                            <div>
                                                <div className="card-title" style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--accent-blue, #00d2ff)' }}>Orchestration Event</div>
                                                <div className="font-mono" style={{ fontSize: '0.75rem', color: 'var(--text-secondary-color, #888)' }}>
                                                    {selectedEvent.agentName || 'Pipeline Orchestrator'} &bull; {new Date(selectedEvent.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                </div>
                                            </div>
                                        </div>
                                        {selectedEvent.executionGroupName && <span className="config-badge model">{selectedEvent.executionGroupName}</span>}
                                    </div>
                                    <div className="info-event-body custom-scrollbar">
                                        <div className="info-event-message font-mono">{selectedEvent.stepDescription}</div>
                                        {selectedEvent.executionGroupId && (
                                            <div className="info-event-meta font-mono" style={{ marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-secondary-color, #888)' }}>
                                                <span style={{ fontWeight: 600 }}>Execution Group: </span>
                                                <span style={{ color: 'var(--accent-blue, #00d2ff)' }}>{selectedEvent.executionGroupId}</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ) : (
                                <div className="inspector-two-columns">
                                    <div className="inspector-column left-column" style={{ paddingRight: '0.75rem' }}>
                                        <div className="unified-prompt-panel">
                                            {selectedPromptEvent?.systemInstruction && (
                                                <div className={`system-instruction-section ${isSystemInstructionExpanded ? 'expanded' : 'collapsed'}`}>
                                                    <div className="system-instruction-pill" onClick={() => setIsSystemInstructionExpanded(!isSystemInstructionExpanded)}>
                                                        <MIcon name={isSystemInstructionExpanded ? 'expand_less' : 'expand_more'} />
                                                        <span>System Instruction</span>
                                                    </div>
                                                    {isSystemInstructionExpanded && (
                                                        <div className="system-prompt-wrapper custom-scrollbar">
                                                            <RenderMathMarkdown content={selectedPromptEvent.systemInstruction} disableSandboxArtifactExpansion={true} />
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            {selectedPromptEvent?.prompt && (
                                                <div className="user-prompt-section">
                                                    <div className="section-header" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', marginBottom: '0.5rem' }}>
                                                        <span className="card-title"><MIcon name="description" /> User Prompt (Injected Context)</span>
                                                    </div>
                                                    <div className="prompt-editor-wrapper custom-scrollbar user-prompt-wrapper">
                                                        <RenderMathMarkdown content={selectedPromptEvent.prompt} disableSandboxArtifactExpansion={true} />
                                                    </div>
                                                    <div className="full-prompt-action" style={{ paddingTop: '0.5rem', marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', display: 'flex' }}>
                                                        <ActionButton
                                                            type="copy"
                                                            content={(selectedPromptEvent.systemInstruction ? `${selectedPromptEvent.systemInstruction}\n\n` : '') + selectedPromptEvent.prompt}
                                                            icon="content_copy"
                                                            text="Copy Full Prompt (System + User)"
                                                            className="full-width-copy-btn"
                                                        />
                                                    </div>
                                                </div>
                                            )}

                                            {!selectedPromptEvent?.systemInstruction && !selectedPromptEvent?.prompt && (
                                                <div className="inspector-empty-prompt" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary-color, #888)', textAlign: 'center', gap: '0.75rem', padding: '2rem 1rem' }}>
                                                    <MIcon name="code" style={{ fontSize: '2rem', opacity: 0.3 }} />
                                                    <span style={{ fontSize: '0.85rem' }}>No prompt context captured for this invocation.</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="vertical-divider" />

                                    <div className="inspector-column right-column" style={{ paddingLeft: '0.75rem' }}>
                                        {selectedEvent.response && responseViewMode === 'activity' && selectedEvent.executionTraceText && (
                                            <SandboxAgentActivity executionTraceText={selectedEvent.executionTraceText} headerExtra={responseViewToggle} />
                                        )}

                                        {selectedEvent.response && (responseViewMode === 'submitted' || !selectedEvent.executionTraceText) && (
                                            <div className="borderless-card">
                                                <div className="section-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.75rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border-color)', marginBottom: '0.5rem' }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                        <span className="card-title"><MIcon name="smart_toy" /> Submitted Artifact</span>
                                                        <div className="code-actions response-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                            {responseViewToggle}
                                                            {responseViewToggle && <div className="action-button-divider" style={{ width: '1px', height: '18px', background: 'var(--border-color)', margin: '0 0.25rem' }} />}
                                                            <ActionButton type="copy" content={selectedEvent.response} icon="content_copy" text="Copy" title="Copy" className="copy-btn-action icon-only-action" />
                                                            <ActionButton type="download" content={selectedEvent.response} filename="submitted-artifact.md" icon="download" text="Download" title="Download" className="download-btn-action icon-only-action" />
                                                        </div>
                                                    </div>
                                                    {(selectedEvent.modelName || selectedEvent.codeExecutionEnabled !== undefined) && (
                                                        <div className="selected-agent-config font-mono" style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                                                            {selectedEvent.modelName && <span className="config-badge model" title="Model Name">{selectedEvent.modelName}</span>}
                                                            {selectedEvent.codeExecutionEnabled !== undefined && <span className="config-badge" title="Terminal permission">Terminal: {selectedEvent.codeExecutionEnabled ? 'On' : 'Off'}</span>}
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="response-math-wrapper custom-scrollbar submitted-artifact-surface">
                                                    <RenderMathMarkdown content={selectedEvent.response} />
                                                </div>
                                            </div>
                                        )}

                                        {(selectedEvent.error || selectedEvent.eventType === 'agent_error') && (
                                            <div className="borderless-card">
                                                <div className="section-header">
                                                    <span className="card-title" style={{ color: '#ff1744' }}><MIcon name="report_problem" /> Error Log</span>
                                                </div>
                                                <div className="error-wrapper custom-scrollbar font-mono">
                                                    {selectedEvent.error || selectedEvent.stepDescription}
                                                </div>
                                            </div>
                                        )}

                                        {!selectedEvent.response && !selectedEvent.error && selectedEvent.eventType !== 'agent_error' && (
                                            <div className="borderless-card pending">
                                                <div className="waiting-wrapper">
                                                    {selectedEvent.eventType === 'agent_complete'
                                                        ? <span>Execution completed with no output artifact.</span>
                                                        : process.status === 'stopped'
                                                            ? <span>Pipeline paused.</span>
                                                            : <><MIcon name="sync" className="waiting-spinner" /><span>Agent is processing, waiting for response...</span></>}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="live-terminal-panel">
                        <div className="terminal-header">
                            <div className="terminal-actions-left">
                                <div className="terminal-dot red" />
                                <div className="terminal-dot yellow" />
                                <div className="terminal-dot green" />
                                <span className="terminal-title font-mono">deepthink-agent-console.log</span>
                            </div>
                            <div className="terminal-actions-right">
                                <div className="console-filter-tabs">
                                    {(['all', 'agents', 'info', 'errors'] as const).map(type => (
                                        <button key={type} className={`tab-button console-tab-button tab-${type} ${filterType === type ? 'active' : ''}`} onClick={() => setFilterType(type)}>
                                            {type.toUpperCase()}
                                        </button>
                                    ))}
                                </div>
                                <div className="search-box">
                                    <MIcon name="search" className="search-icon" />
                                    <input type="text" placeholder="Search logs..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="search-input" />
                                </div>
                            </div>
                        </div>

                        <div className="terminal-body font-mono custom-scrollbar">
                            {filteredEvents.length === 0 ? (
                                <div className="terminal-row empty">Console is silent. Awaiting execution stream...</div>
                            ) : (
                                filteredEvents.map(ev => {
                                    const category = getAgentCategory(ev.agentName, ev.stepDescription);
                                    const lineClass = ev.eventType === 'agent_start' ? 'log-start' : ev.eventType === 'agent_complete' ? 'log-complete' : ev.eventType === 'agent_error' ? 'log-error' : ev.eventType === 'agent_retry' ? 'log-retry' : 'log-info';
                                    const badge = ev.eventType === 'agent_start' ? '[START]' : ev.eventType === 'agent_complete' ? '[DONE]' : ev.eventType === 'agent_error' ? '[FAIL]' : ev.eventType === 'agent_retry' ? '[RETRY]' : '[INFO]';
                                    return (
                                        <div key={ev.id} className={`terminal-row ${lineClass} ${selectedEvent?.id === ev.id ? 'highlighted' : ''} category-${category}`} onClick={() => selectEvent(ev)}>
                                            <span className="log-time">{new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                            <span className="log-badge">{badge}</span>
                                            {ev.agentName && <span className="log-agent">[{formatAgentName(ev.agentName, ev.stepDescription)}]</span>}
                                            <span className="log-message">{ev.stepDescription}</span>
                                        </div>
                                    );
                                })
                            )}
                            <div ref={terminalEndRef} />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
