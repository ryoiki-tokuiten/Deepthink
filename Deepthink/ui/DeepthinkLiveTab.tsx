import React, { useEffect, useState, useRef } from 'react';
import { DeepthinkPipelineState, DeepthinkLiveEvent } from '../core/deepthinkCore';
import { Icon as MIcon } from '../../UI/Icons';
import { ActionButton } from '../../Styles/Components/ActionButton';
import RenderMathMarkdown from '../../Styles/Components/RenderMathMarkdown';

import { updateControlsState } from '../../UI/Controls';
import { SandboxAgentActivity } from './SandboxAgentActivity';
import '../styles/DeepthinkLiveTab.css';

interface DeepthinkLiveTabProps {
    process: DeepthinkPipelineState;
    hideStopButton?: boolean;
}

export const DeepthinkLiveTab: React.FC<DeepthinkLiveTabProps> = ({ process, hideStopButton }) => {
    const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
    const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
    const [filterType, setFilterType] = useState<'all' | 'agents' | 'info' | 'errors'>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [timeElapsed, setTimeElapsed] = useState('00:00');
    const [isSystemInstructionExpanded, setIsSystemInstructionExpanded] = useState(false);
    const [responseViewMode, setResponseViewMode] = useState<'submitted' | 'activity'>('submitted');
    const [isUserSelected, setIsUserSelected] = useState(false);
    const [, setForceUpdate] = useState(0);

    const terminalEndRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const startTimeRef = useRef<number>(Date.now());

    // A selection is intentional user state. Reset it only for a different
    // Deepthink run, never just because another agent produces an event.
    useEffect(() => {
        setSelectedEventId(null);
        setSelectedAgentName(null);
        setIsUserSelected(false);
    }, [process.id]);

    // Timer logic for execution duration
    useEffect(() => {
        if (process.status === 'processing') {
            const firstEvent = process.liveEvents?.[0];
            const baseTime = firstEvent ? firstEvent.timestamp : Date.now();
            startTimeRef.current = baseTime;

            const updateTimer = () => {
                const diff = Date.now() - startTimeRef.current;
                const secs = Math.floor((diff / 1000) % 60);
                const mins = Math.floor((diff / 1000 / 60) % 60);
                setTimeElapsed(`${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`);
            };

            updateTimer();
            timerRef.current = setInterval(updateTimer, 1000);
        } else {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }

            const events = process.liveEvents || [];
            if (events.length > 1) {
                const diff = events[events.length - 1].timestamp - events[0].timestamp;
                const totalSecs = Math.floor(diff / 1000);
                const secs = totalSecs % 60;
                const mins = Math.floor(totalSecs / 60) % 60;
                setTimeElapsed(`${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`);
            } else {
                setTimeElapsed('00:00');
            }
        }

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [process.status, process.liveEvents?.length]);

    // Global reset to auto-follow latest agent when Live tab is opened
    useEffect(() => {
        const handleLiveTabOpened = () => {
            setIsUserSelected(false);
        };
        window.addEventListener('deepthinkLiveTabOpened', handleLiveTabOpened);
        return () => window.removeEventListener('deepthinkLiveTabOpened', handleLiveTabOpened);
    }, []);

    // Auto scroll logic (always auto-scroll to bottom of terminal console on new event)
    useEffect(() => {
        if (terminalEndRef.current) {
            terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [process.liveEvents?.length]);

    const events = process.liveEvents || [];

    // Follow the latest agent unless the user has explicitly selected one
    useEffect(() => {
        if (isUserSelected) return;
        const lastAgentEvent = [...events].reverse().find(event => (
            !!event.agentName && (event.eventType === 'agent_start' || event.eventType === 'agent_complete' || event.eventType === 'agent_retry' || event.eventType === 'agent_error')
        ));
        if (!lastAgentEvent) return;
        setSelectedEventId(lastAgentEvent.id);
        setSelectedAgentName(lastAgentEvent.executionId || lastAgentEvent.agentName);
    }, [process.id, process.liveEvents?.length, isUserSelected]);

    // Helper to determine agent category for color mapping
    const getAgentCategory = (agentName: string, stepDescription: string): string => {
        const name = (agentName || '').toLowerCase();
        const desc = (stepDescription || '').toLowerCase();

        // BSR / Branch State Decision
        if (name.includes('bsr') || desc.includes('bsr') || name.includes('branch state') || desc.includes('branch state')) {
            return 'redteam'; // Distinct decision/evaluation color
        }
        // DOS / Global Synthesis
        if (name.includes('dos') || desc.includes('dos') || name.includes('synthesis') || desc.includes('synthesis')) {
            return 'critique'; // Synthesis
        }
        // Critique
        if (name.includes('critique') || desc.includes('critique') || name.includes('critic') || desc.includes('critic')) {
            return 'critique'; // Yellow
        }
        // Correction
        if (name.includes('correction') || desc.includes('correction')) {
            return 'correction'; // Green
        }
        // Memory Bank
        if (name.includes('memory') || desc.includes('memory')) {
            return 'strategy'; // Cyan/Purple
        }
        // Final Judge
        if (name.includes('judge') || desc.includes('judge')) {
            return 'strategy';
        }
        // Modules / Tester
        if (
            name.includes('modules') || desc.includes('modules') ||
            name.includes('tester') || desc.includes('tester')
        ) {
            return 'modules'; // Blue
        }
        // Strategy / Execution / Attempt / Solver / Proximity
        if (
            name.includes('strategy') || desc.includes('strategy') || 
            name.includes('attempt') || desc.includes('attempt') || 
            name.includes('execution') || desc.includes('execution') ||
            name.includes('solver') || desc.includes('solver') ||
            name.includes('proximity') || desc.includes('proximity')
        ) {
            return 'strategy'; // Purple
        }
        return 'general';
    };

    const formatAgentName = (agentName: string, stepDescription: string): string => {
        if (!agentName) return '';
        const name = agentName;
        const desc = stepDescription || '';
        const lowerName = name.toLowerCase();

        const metaMatch = desc.match(/\(([^)]+)\)/);
        const meta = metaMatch ? metaMatch[1] : '';

        const targetMatch = desc.match(/for\s+([a-zA-Z0-9_-]+)/i);
        const target = targetMatch ? targetMatch[1] : '';

        if (lowerName.includes('solution attempt')) {
            const parts = [target, meta].filter(Boolean);
            return parts.length > 0 ? `Initial Execution (${parts.join(', ')})` : 'Initial Execution';
        }
        if (lowerName.includes('solution correction')) {
            const parts = [target, meta].filter(Boolean);
            return parts.length > 0 ? `Correction Agent (${parts.join(', ')})` : 'Correction Agent';
        }
        if (lowerName.includes('final judge')) return 'Final Judge Agent';
        
        if (lowerName.includes('solution critique')) {
            const parts = [target, meta].filter(Boolean);
            return parts.length > 0 ? `Critique Agent (${parts.join(', ')})` : 'Critique Agent';
        }

        if (lowerName.includes('dissected observations') || lowerName.includes('synthesis')) {
            const isStepI = desc.toLowerCase().includes('step-i');
            const prefix = isStepI ? 'step-i, For ' : 'For ';
            return meta ? `Dissected Observations Synthesis Agent (${prefix}${meta})` : 'Dissected Observations Synthesis Agent';
        }

        if (lowerName.includes('branch state')) {
            const parts = [target, meta].filter(Boolean);
            return parts.length > 0 ? `Branch State Representation Agent (${parts.join(', ')})` : 'Branch State Representation Agent';
        }

        if (lowerName.includes('memory bank')) {
            const parts = [target, meta].filter(Boolean);
            return parts.length > 0 ? `Memory Bank Agent (${parts.join(', ')})` : 'Memory Bank Agent';
        }

        if (lowerName.includes('modules testing')) {
            const mMatch = desc.match(/\b(m\d+)\b/i);
            const mPart = mMatch ? mMatch[1] : '';
            const parts = [mPart, meta].filter(Boolean);
            return parts.length > 0 ? `Modules Testing Agent (${parts.join(', ')})` : 'Modules Testing Agent';
        }
        
        if (lowerName.includes('modules generation') || lowerName.includes('modules generator')) {
            return meta ? `Modules Generator Agent (${meta})` : 'Modules Generator Agent';
        }

        if (lowerName.includes('modules impact review') || lowerName.includes('modules impact reviewer')) {
            return meta ? `Modules Impact Reviewer Agent (${meta})` : 'Modules Impact Reviewer Agent';
        }

        if (meta) {
            return `${name} (${meta})`;
        }

        return name;
    };

    // Filtered events for the terminal log console
    const filteredEvents = events.filter(ev => {
        if (filterType === 'agents' && !['agent_start', 'agent_complete', 'agent_error', 'agent_retry'].includes(ev.eventType)) return false;
        if (filterType === 'info' && ev.eventType !== 'info') return false;
        if (filterType === 'errors' && ev.eventType !== 'agent_error') return false;

        if (searchQuery) {
            const query = searchQuery.toLowerCase();
            return (
                ev.agentName.toLowerCase().includes(query) ||
                ev.stepDescription.toLowerCase().includes(query) ||
                (ev.prompt && ev.prompt.toLowerCase().includes(query)) ||
                (ev.response && ev.response.toLowerCase().includes(query)) ||
                (ev.error && ev.error.toLowerCase().includes(query))
            );
        }
        return true;
    });

    // Unique agents list for the timeline: track all invocations across all phases and iterations
    const agentEventsMap = new Map<string, DeepthinkLiveEvent>();
    events.forEach(ev => {
        if (ev.agentName) {
            const key = ev.executionId || ev.agentName;
            if (ev.eventType === 'agent_start' || ev.eventType === 'agent_complete' || ev.eventType === 'agent_error' || ev.eventType === 'agent_retry') {
                agentEventsMap.set(key, ev);
            }
        }
    });
    const allTimelineAgents = Array.from(agentEventsMap.values());

    // Follow a selected agent from start to completion, but never replace a
    // deliberate selection with whichever agent happened to run most recently.
    const selectedEventById = selectedEventId ? events.find(event => event.id === selectedEventId) : undefined;
    let selectedEvent = selectedAgentName
        ? agentEventsMap.get(selectedAgentName) || selectedEventById
        : selectedEventById;

    if (!selectedEvent && !selectedAgentName && allTimelineAgents.length > 0) {
        const firstAgent = allTimelineAgents[0];
        if (firstAgent && firstAgent.agentName) {
            const key = firstAgent.executionId || firstAgent.agentName;
            const latestAgentEvent = agentEventsMap.get(key);
            if (latestAgentEvent) {
                selectedEvent = latestAgentEvent;
            }
        }
    }

    if (!selectedEvent) {
        selectedEvent = events[events.length - 1];
    }
    const selectedInvocationStart = selectedEvent?.executionId
        ? events.find(event =>
            event.executionId === selectedEvent?.executionId
            && event.eventType === 'agent_start')
        : undefined;
    const selectedPromptEvent = selectedInvocationStart || selectedEvent;

    const selectEvent = (event: DeepthinkLiveEvent) => {
        setSelectedEventId(event.id);
        setSelectedAgentName(event.executionId || event.agentName || null);
        setIsUserSelected(true);
    };

    useEffect(() => {
        setResponseViewMode('submitted');
    }, [selectedEvent?.id]);

    const responseViewToggle = selectedEvent?.executionTraceText && (
        <div className="response-view-toggle" aria-label="Response view">
            <button
                className={`response-toggle-option ${responseViewMode === 'submitted' ? 'active' : ''}`}
                onClick={() => setResponseViewMode('submitted')}
            >
                Artifact
            </button>
            <button
                className={`response-toggle-option ${responseViewMode === 'activity' ? 'active' : ''}`}
                onClick={() => setResponseViewMode('activity')}
            >
                Agent Activity
            </button>
        </div>
    );

    const renderTimelineNode = (agent: DeepthinkLiveEvent) => {
        const isActive = selectedEvent ? (
            (selectedEvent.executionId && selectedEvent.executionId === agent.executionId) ||
            (!selectedEvent.executionId && selectedEvent.agentName === agent.agentName)
        ) : false;
        const category = getAgentCategory(agent.agentName, agent.stepDescription);
        let statusClass = 'pending';
        let statusIcon = 'hourglass_empty';

        if (agent.eventType === 'agent_complete') {
            statusClass = 'completed';
            statusIcon = 'check';
        } else if (agent.eventType === 'agent_start' || agent.eventType === 'agent_retry') {
            statusClass = 'running';
            statusIcon = 'sync';
        } else if (agent.eventType === 'agent_error') {
            statusClass = 'failed';
            statusIcon = 'error';
        }

        return (
            <div 
                key={agent.id} 
                className={`timeline-node ${statusClass} ${isActive ? 'active' : ''} category-${category}`}
                onClick={() => selectEvent(agent)}
            >
                <div className="node-connector-line"></div>
                <div className="node-icon-wrapper">
                    <MIcon name={statusIcon} className="node-status-icon" />
                </div>
                <div className="node-content" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <div className="node-header">
                        <span className="node-name font-mono">{formatAgentName(agent.agentName, agent.stepDescription)}</span>
                        <span className="node-time font-mono">
                            {new Date(agent.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="deepthink-live-container">
            {/* Split Screen Workspace */}
            <div className="live-workspace" style={{ flexDirection: 'row-reverse' }}>
                {/* Left Side: Agent Timeline */}
                <div className="live-sidebar">
                    <div className="timeline-header-panel">
                        <div className="timeline-header-row-bottom">
                            <div className={`status-pill status-${process.status === 'stopped' ? 'error' : process.status} compact-status`}>
                                <span className="pulse-indicator"></span>
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
                                const blocks: Array<
                                    | { type: 'single'; agent: DeepthinkLiveEvent }
                                    | { type: 'group'; id: string; name: string; agents: DeepthinkLiveEvent[] }
                                > = [];
                                
                                sortedAgents.forEach(agent => {
                                    if (agent.executionGroupId) {
                                        const existingGroup = blocks.find(b => b.type === 'group' && b.id === agent.executionGroupId);
                                        if (existingGroup && existingGroup.type === 'group') {
                                            existingGroup.agents.push(agent);
                                        } else {
                                            blocks.push({ type: 'group', id: agent.executionGroupId, name: agent.executionGroupName || 'Execution Loop', agents: [agent] });
                                        }
                                    } else {
                                        blocks.push({ type: 'single', agent });
                                    }
                                });

                                // Check if we have multiple generic running agents to group into a "Parallel" block
                                return blocks.map((block) => {
                                    if (block.type === 'single') {
                                        return renderTimelineNode(block.agent);
                                    } else {
                                        const isRunning = process.status !== 'stopped' && block.agents.some(a =>
                                            a.eventType === 'agent_start' || a.eventType === 'agent_retry'
                                        );
                                        return (
                                            <div key={block.id} className={`parallel-active-window ${isRunning ? 'running' : 'completed'}`}>
                                                <div className="parallel-window-header">
                                                    <MIcon name={isRunning ? "sync" : "check_circle"} className={isRunning ? "parallel-icon spin" : "parallel-icon"} style={{ fontSize: '1rem', animation: isRunning ? 'spin 4s linear infinite' : 'none' }} />
                                                    <span>{block.name}</span>
                                                </div>
                                                <div className="parallel-window-body">
                                                    {block.agents.map(renderTimelineNode)}
                                                </div>
                                            </div>
                                        );
                                    }
                                });
                            })()
                        )}
                    </div>
                    
                </div>

                {/* Right Side: Terminal Log & Prompt Inspector */}
                <div className="live-main-content">
                    {/* Top Right: Inspector */}
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
                                            <span className="info-icon-badge">
                                                <MIcon name="info" />
                                            </span>
                                            <div>
                                                <div className="card-title" style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--accent-blue, #00d2ff)' }}>
                                                    Orchestration Event
                                                </div>
                                                <div className="font-mono" style={{ fontSize: '0.75rem', color: 'var(--text-secondary-color, #888)' }}>
                                                    {selectedEvent.agentName || 'Pipeline Orchestrator'} &bull; {new Date(selectedEvent.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                </div>
                                            </div>
                                        </div>
                                        {selectedEvent.executionGroupName && (
                                            <span className="config-badge model">
                                                {selectedEvent.executionGroupName}
                                            </span>
                                        )}
                                    </div>
                                    <div className="info-event-body custom-scrollbar">
                                        <div className="info-event-message font-mono">
                                            {selectedEvent.stepDescription}
                                        </div>
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
                                    {/* Left Column: System & User Prompts */}
                                    <div className="inspector-column left-column" style={{ paddingRight: '0.75rem' }}>
                                        <div className="unified-prompt-panel">
                                            {selectedPromptEvent?.systemInstruction && (
                                                <div className={`system-instruction-section ${isSystemInstructionExpanded ? 'expanded' : 'collapsed'}`}>
                                                    <div 
                                                        className="system-instruction-pill"
                                                        onClick={() => setIsSystemInstructionExpanded(!isSystemInstructionExpanded)}
                                                    >
                                                        <MIcon name={isSystemInstructionExpanded ? "expand_less" : "expand_more"} />
                                                        <span>System Instruction</span>
                                                    </div>
                                                    {isSystemInstructionExpanded && (
                                                        <div className="system-prompt-wrapper custom-scrollbar">
                                                            <RenderMathMarkdown 
                                                                content={selectedPromptEvent.systemInstruction} 
                                                                disableSandboxArtifactExpansion={true} 
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            {selectedPromptEvent?.prompt && (
                                                <div className="user-prompt-section">
                                                    <div className="section-header" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', marginBottom: '0.5rem' }}>
                                                        <span className="card-title">
                                                            <MIcon name="description" /> User Prompt (Injected Context)
                                                        </span>
                                                    </div>
                                                    <div className="prompt-editor-wrapper custom-scrollbar user-prompt-wrapper">
                                                        <RenderMathMarkdown 
                                                            content={selectedPromptEvent.prompt} 
                                                            disableSandboxArtifactExpansion={true} 
                                                        />
                                                    </div>
                                                    <div className="full-prompt-action" style={{ paddingTop: '0.5rem', marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', display: 'flex' }}>
                                                        <ActionButton
                                                            type="copy"
                                                            content={(selectedPromptEvent.systemInstruction ? selectedPromptEvent.systemInstruction + '\n\n' : '') + selectedPromptEvent.prompt}
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

                                    <div className="vertical-divider"></div>

                                    {/* Right Column: Model Response / Errors */}
                                    <div className="inspector-column right-column" style={{ paddingLeft: '0.75rem' }}>
                                        {selectedEvent.response && responseViewMode === 'activity' && selectedEvent.executionTraceText && (
                                            <SandboxAgentActivity
                                                executionTraceText={selectedEvent.executionTraceText}
                                                headerExtra={responseViewToggle}
                                            />
                                        )}

                                        {selectedEvent.response && (responseViewMode === 'submitted' || !selectedEvent.executionTraceText) && (
                                            <div className="borderless-card">
                                                <div className="section-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.75rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border-color)', marginBottom: '0.5rem' }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                        <span className="card-title">
                                                            <MIcon name="smart_toy" /> Submitted Artifact
                                                        </span>
                                                        <div className="code-actions response-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                            {responseViewToggle}
                                                            {responseViewToggle && (
                                                                <div className="action-button-divider" style={{ width: '1px', height: '18px', background: 'var(--border-color)', margin: '0 0.25rem' }} />
                                                            )}
                                                            <ActionButton
                                                                type="copy"
                                                                content={selectedEvent.response}
                                                                icon="content_copy"
                                                                text="Copy"
                                                                title="Copy"
                                                                className="copy-btn-action icon-only-action"
                                                            />
                                                            <ActionButton
                                                                type="download"
                                                                content={selectedEvent.response}
                                                                filename="submitted-artifact.md"
                                                                icon="download"
                                                                text="Download"
                                                                title="Download"
                                                                className="download-btn-action icon-only-action"
                                                            />
                                                        </div>
                                                    </div>
                                                    {selectedEvent && (selectedEvent.modelName || selectedEvent.codeExecutionEnabled !== undefined) && (
                                                        <div className="selected-agent-config font-mono" style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                                                            {selectedEvent.modelName && (
                                                                <span className="config-badge model" title="Model Name">
                                                                    {selectedEvent.modelName}
                                                                </span>
                                                            )}
                                                            {selectedEvent.codeExecutionEnabled !== undefined && (
                                                                <span className="config-badge" title="Terminal permission">
                                                                    Terminal: {selectedEvent.codeExecutionEnabled ? 'On' : 'Off'}
                                                                </span>
                                                            )}
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
                                                    <span className="card-title" style={{ color: '#ff1744' }}>
                                                        <MIcon name="report_problem" /> Error Log
                                                    </span>
                                                </div>
                                                <div className="error-wrapper custom-scrollbar font-mono">
                                                    {selectedEvent.error || selectedEvent.stepDescription}
                                                </div>
                                            </div>
                                        )}

                                        {!selectedEvent.response && !selectedEvent.error && selectedEvent.eventType !== 'agent_error' && (
                                            <div className="borderless-card pending">
                                                <div className="waiting-wrapper">
                                                    {selectedEvent.eventType === 'agent_complete' ? (
                                                        <span>Execution completed with no output artifact.</span>
                                                    ) : process.status === 'stopped' ? (
                                                        <span>Pipeline paused.</span>
                                                    ) : (
                                                        <>
                                                            <MIcon name="sync" className="waiting-spinner" />
                                                            <span>Agent is processing, waiting for response...</span>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Bottom Right: Terminal Log Console */}
                    <div className="live-terminal-panel">
                        <div className="terminal-header">
                            <div className="terminal-actions-left">
                                <div className="terminal-dot red"></div>
                                <div className="terminal-dot yellow"></div>
                                <div className="terminal-dot green"></div>
                                <span className="terminal-title font-mono">deepthink-agent-console.log</span>
                            </div>
                            <div className="terminal-actions-right">
                                <div className="console-filter-tabs">
                                    {(['all', 'agents', 'info', 'errors'] as const).map(type => (
                                        <button 
                                            key={type}
                                            className={`tab-button console-tab-button tab-${type} ${filterType === type ? 'active' : ''}`}
                                            onClick={() => setFilterType(type)}
                                        >
                                            {type.toUpperCase()}
                                        </button>
                                    ))}
                                </div>
                                <div className="search-box">
                                    <MIcon name="search" className="search-icon" />
                                    <input 
                                        type="text" 
                                        placeholder="Search logs..." 
                                        value={searchQuery}
                                        onChange={e => setSearchQuery(e.target.value)}
                                        className="search-input"
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="terminal-body font-mono custom-scrollbar">
                            {filteredEvents.length === 0 ? (
                                <div className="terminal-row empty">Console is silent. Awaiting execution stream...</div>
                            ) : (
                                filteredEvents.map((ev) => {
                                    const category = getAgentCategory(ev.agentName, ev.stepDescription);
                                    let lineClass = 'log-info';
                                    let badge = '[INFO]';

                                    if (ev.eventType === 'agent_start') {
                                        lineClass = 'log-start';
                                        badge = '[START]';
                                    } else if (ev.eventType === 'agent_complete') {
                                        lineClass = 'log-complete';
                                        badge = '[DONE]';
                                    } else if (ev.eventType === 'agent_error') {
                                        lineClass = 'log-error';
                                        badge = '[FAIL]';
                                    } else if (ev.eventType === 'agent_retry') {
                                        lineClass = 'log-retry';
                                        badge = '[RETRY]';
                                    }

                                    return (
                                        <div 
                                            key={ev.id} 
                                            className={`terminal-row ${lineClass} ${selectedEvent?.id === ev.id ? 'highlighted' : ''} category-${category}`}
                                            onClick={() => selectEvent(ev)}
                                        >
                                            <span className="log-time">
                                                {new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                            <span className="log-badge">{badge}</span>
                                            {ev.agentName && (
                                                <span className="log-agent">[{formatAgentName(ev.agentName, ev.stepDescription)}]</span>
                                            )}
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
