import React, { useState, useEffect, useCallback, memo } from 'react';
import ReactDOM from 'react-dom/client';
import RenderMathMarkdown from '../../Styles/Components/RenderMathMarkdown';
import { ActionButton } from '../../Styles/Components/ActionButton';
import { AgentActivityPanel, SandboxAgentActivity } from '../../Styles/Components/AgentActivity/AgentActivityPanel';
import { Icon } from '../../UI/Icons';

interface BranchHistoryMessage {
    id: string;
    role: 'solution_attempt' | 'solution_critique';
    content: string;
    timestamp: number;
    iterationNumber: number;
    artifactContent?: string;
    executionTrace?: string;
}

interface BranchHistoryState {
    contentHistory: Array<{
        content: string;
        title: string;
        timestamp: number;
    }>;
    messages: BranchHistoryMessage[];
    isProcessing: boolean;
}

type RoleMeta = { icon: string; title: string; cardClass: string; modalTitle?: string };

const ROLE_META: Record<BranchHistoryMessage['role'], RoleMeta> = {
    solution_attempt: { icon: 'auto_fix_high', title: 'Execution Agent', cardClass: 'solution-attempt-card' },
    solution_critique: { icon: 'Troubleshoot', title: 'Solution Critique', cardClass: 'solution-critique-card', modalTitle: 'Solution Critique Details' },
};

const getRoleInfo = (role: BranchHistoryMessage['role'], _iterationNumber?: number): RoleMeta => {
    return ROLE_META[role];
};

const EmbeddedModalViewer: React.FC<{
    message: BranchHistoryMessage | null;
    allMessages: BranchHistoryMessage[];
    onClose: () => void;
    onNavigate: (message: BranchHistoryMessage) => void;
}> = memo(({ message, allMessages, onClose, onNavigate }) => {
    const [viewMode, setViewMode] = useState<'response' | 'activity'>('response');

    useEffect(() => {
        setViewMode('response');
    }, [message?.id]);

    useEffect(() => {
        if (!message) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                const idx = allMessages.findIndex(m => m.id === message.id);
                const next = allMessages[idx + (e.key === 'ArrowLeft' ? -1 : 1)];
                if (next) onNavigate(next);
            }
        };
        document.addEventListener('keydown', handleKeyDown, true);
        return () => document.removeEventListener('keydown', handleKeyDown, true);
    }, [message, allMessages, onClose, onNavigate]);

    if (!message) return null;

    const currentIndex = allMessages.findIndex(m => m.id === message.id);
    const hasPrev = currentIndex > 0;
    const hasNext = currentIndex < allMessages.length - 1;
    const roleInfo = getRoleInfo(message.role, message.iterationNumber);
    const modalTitle = roleInfo.modalTitle || roleInfo.title;
    const hasExecutionTrace = Boolean(message.executionTrace);

    return (
        <div className="embedded-modal-overlay" onClick={onClose}>
            <div className="embedded-modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <div className="embedded-modal-header-left">
                        {allMessages.length > 1 && (
                            <div className="embedded-modal-nav">
                                <button
                                    className="modal-nav-btn"
                                    onClick={() => hasPrev && onNavigate(allMessages[currentIndex - 1])}
                                    disabled={!hasPrev}
                                    title="Previous (←)"
                                >
                                    <Icon name="chevron_left" />
                                </button>
                                <button
                                    className="modal-nav-btn"
                                    onClick={() => hasNext && onNavigate(allMessages[currentIndex + 1])}
                                    disabled={!hasNext}
                                    title="Next (→)"
                                >
                                    <Icon name="chevron_right" />
                                </button>
                            </div>
                        )}
                        <h4>{modalTitle}</h4>
                    </div>
                    <div className="embedded-modal-header-controls">
                        <span className="iteration-indicator">#{message.iterationNumber}</span>
                        {hasExecutionTrace && (
                            <button
                                type="button"
                                className={`modal-nav-btn ${viewMode === 'activity' ? 'active' : ''}`}
                                onClick={() => setViewMode(prev => prev === 'response' ? 'activity' : 'response')}
                                title={viewMode === 'response' ? 'View Agent Activity' : 'View Full Response'}
                            >
                                <Icon name={viewMode === 'response' ? 'terminal' : 'article'} />
                            </button>
                        )}
                        <ActionButton
                            content={message.content}
                            type="copy"
                            icon="content_copy"
                            text=""
                            title="Copy response"
                            className="modal-nav-btn"
                        />
                        <button className="close-modal-btn" onClick={onClose} title="Close (ESC)">
                            <Icon name="close" />
                        </button>
                    </div>
                </div>
                <div className="modal-body custom-scrollbar">
                    <div className="modal-content-wrapper">
                        {viewMode === 'activity' && hasExecutionTrace ? (
                            <SandboxAgentActivity executionTraceText={message.executionTrace} />
                        ) : (
                            <RenderMathMarkdown content={message.content} />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
});

const MinimalMessageCard: React.FC<{
    message: BranchHistoryMessage;
    onViewDetails: (message: BranchHistoryMessage) => void;
}> = memo(({ message, onViewDetails }) => {
    const { icon, title, cardClass } = getRoleInfo(message.role, message.iterationNumber);

    return (
        <div className={`minimal-message-card ${cardClass}`}>
            <div className="minimal-card-header">
                <Icon name={icon} className="card-icon" />
                <span className="card-title">{title}</span>
                <span className="card-iteration">#{message.iterationNumber}</span>
            </div>
            <div className="minimal-card-content">
                <RenderMathMarkdown content={message.content} />
            </div>
            <div style={{ padding: '0 0.75rem 0.75rem 0.75rem', marginTop: 'auto', flexShrink: 0 }}>
                <button className="action-btn" onClick={() => onViewDetails(message)} style={{ width: '100%', justifyContent: 'center' }}>
                    <Icon name="visibility" />
                    <span className="button-text">Full Response</span>
                </button>
            </div>
        </div>
    );
});

const CurrentArtifactPanel: React.FC<{ state: BranchHistoryState }> = memo(({ state }) => {
    const currentGeneration = state.contentHistory[state.contentHistory.length - 1];

    if (!currentGeneration) {
        return (
            <div className="branch-artifact-panel">
                <div className="text-panel-header">
                    <h3>Current Artifact</h3>
                </div>
                <div className="text-content-container">
                    <div className="empty-state">
                        <Icon name="auto_awesome" className="empty-icon" />
                        <p>Generating initial solution...</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="branch-artifact-panel">
            <div className="text-panel-header">
                <h3>
                    Current Artifact
                    <span className="iteration-badge" style={{ marginLeft: '0.75rem' }}>
                        #{state.contentHistory.length}
                    </span>
                </h3>
                <div className="text-panel-actions">
                    <ActionButton content={currentGeneration.content} type="copy" icon="content_copy" text="Copy" />
                    <ActionButton
                        content={currentGeneration.content}
                        type="download"
                        icon="download"
                        text="Download"
                        filename={`branch-artifact-v${state.contentHistory.length}-${Date.now()}.md`}
                    />
                </div>
            </div>
            <div className="text-content-container custom-scrollbar">
                <RenderMathMarkdown content={currentGeneration.content} />
            </div>
        </div>
    );
});

const BranchHistoryApp: React.FC<{ initialState: BranchHistoryState }> = ({ initialState }) => {
    const [state, setState] = useState<BranchHistoryState>(initialState);
    const [selectedMessage, setSelectedMessage] = useState<BranchHistoryMessage | null>(null);

    useEffect(() => {
        const handleStateUpdate = (event: CustomEvent) => {
            setState({ ...event.detail });
        };
        window.addEventListener('deepthinkBranchHistoryUpdated' as any, handleStateUpdate);
        return () => {
            window.removeEventListener('deepthinkBranchHistoryUpdated' as any, handleStateUpdate);
        };
    }, []);

    const handleCloseModal = useCallback(() => setSelectedMessage(null), []);

    return (
        <div className="branch-history-ui-container">
            <CurrentArtifactPanel state={state} />
            <AgentActivityPanel isProcessing={state.isProcessing} className="branch-history-agent-panel">
                {state.messages.map((msg) => (
                    <MinimalMessageCard
                        key={msg.id}
                        message={msg}
                        onViewDetails={setSelectedMessage}
                    />
                ))}
            </AgentActivityPanel>
            <EmbeddedModalViewer
                message={selectedMessage}
                allMessages={state.messages}
                onClose={handleCloseModal}
                onNavigate={setSelectedMessage}
            />
        </div>
    );
};

let branchHistoryRoot: ReactDOM.Root | null = null;
let branchHistoryContainer: HTMLElement | null = null;

export async function renderBranchHistoryUI(
    container: HTMLElement,
    originalSolution: string,
    currentBestSolution: string,
    iterations: Array<{
        iterationNumber: number;
        critique: string;
        correctedSolution: string;
        timestamp: number;
        critiqueExecutionTraceText?: string;
        correctedSolutionExecutionTraceText?: string;
    }>,
    isProcessing: boolean = false
) {
    const branchState: BranchHistoryState = {
        contentHistory: [],
        messages: [],
        isProcessing,
    };

    iterations.forEach((iter, index) => {
        const isFirst = index === 0;
        if (iter.correctedSolution) {
            branchState.contentHistory.push({
                content: iter.correctedSolution,
                title: `Execution ${iter.iterationNumber}`,
                timestamp: iter.timestamp - (isFirst ? 1000 : 0)
            });

            branchState.messages.push({
                id: `branch-gen-${iter.iterationNumber}`,
                role: 'solution_attempt',
                content: iter.correctedSolution,
                timestamp: iter.timestamp - (isFirst ? 1000 : 0),
                iterationNumber: iter.iterationNumber,
                artifactContent: iter.correctedSolution,
                executionTrace: iter.correctedSolutionExecutionTraceText
            });
        }

        if (iter.critique) {
            branchState.messages.push({
                id: `branch-critique-${iter.iterationNumber}`,
                role: 'solution_critique',
                content: iter.critique,
                timestamp: iter.timestamp - 500,
                iterationNumber: iter.iterationNumber,
                executionTrace: iter.critiqueExecutionTraceText
            });
        }
    });

    if (branchState.contentHistory.length === 0 && (currentBestSolution || originalSolution)) {
        branchState.contentHistory.push({
            content: currentBestSolution || originalSolution,
            title: 'Attempt 1',
            timestamp: Date.now()
        });
    }

    if (branchHistoryRoot && branchHistoryContainer === container) {
        window.dispatchEvent(new CustomEvent('deepthinkBranchHistoryUpdated', { detail: branchState }));
        return;
    }

    if (branchHistoryRoot) {
        const oldRoot = branchHistoryRoot;
        branchHistoryRoot = null;
        branchHistoryContainer = null;
        setTimeout(() => oldRoot.unmount(), 0);
    }

    container.innerHTML = '';
    branchHistoryContainer = container;
    branchHistoryRoot = ReactDOM.createRoot(container);
    branchHistoryRoot.render(<BranchHistoryApp initialState={branchState} />);
}
