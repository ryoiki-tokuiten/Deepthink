import { exportConfiguration, handleImportConfiguration } from './ConfigManager';
import { updateUIAfterModeChange } from './AppRouter';
import {
    ensureAdaptiveDeepthinkInitialized,
    ensureContextualInitialized,
    ensureDeepthinkInitialized,
} from './ModeLoader';
import { routingManager, initializeRouting, hasValidApiKey } from '../Routing';
import { globalState } from './State';
import { ApplicationMode } from './Types';
import { updateControlsState } from '../UI/Controls';
import { LayoutController } from '../UI/LayoutController';
import { countFileTokens, getMediaCounts, DIRECT_CONTEXT_MEDIA_LIMITS, DIRECT_CONTEXT_TOKEN_LIMIT } from '../Styles/Components/Sidebar/FileUpload';

export class App {
    public static init() {
        initializeRouting();
        routingManager.refreshProviders();
        routingManager.initializePromptsManager(
            { current: globalState.customPromptsDeepthinkState },
            { current: globalState.customPromptsContextualState }
        );
        updateUIAfterModeChange();

        const appModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="app-mode"]');
        let modeIsAlreadySet = false;
        appModeRadios.forEach(radio => {
            if (radio.checked) {
                globalState.currentMode = radio.value as ApplicationMode;
                modeIsAlreadySet = true;
            }
        });
        if (!modeIsAlreadySet && appModeRadios.length > 0) {
            appModeRadios[0].checked = true;
            globalState.currentMode = appModeRadios[0].value as ApplicationMode;
        }

        updateUIAfterModeChange();
        updateControlsState();
        document.getElementById('preloader')?.classList.add('hidden');
        LayoutController.initialize();
    }

    public static async handleGenerate(initialIdea: string) {
        if (!hasValidApiKey()) {
            alert("No providers are configured. Please configure at least one AI provider using the 'Add Providers' button.");
            return;
        }
        if (!initialIdea) {
            alert("Please enter an idea, premise, or request.");
            return;
        }

        const directFiles = globalState.directContextFiles;
        const directMedia = getMediaCounts(directFiles);
        if (countFileTokens(directFiles) > DIRECT_CONTEXT_TOKEN_LIMIT || directMedia.images > DIRECT_CONTEXT_MEDIA_LIMITS.images) {
            alert(`Direct context exceeds its limit: ${DIRECT_CONTEXT_TOKEN_LIMIT.toLocaleString()} text tokens and ${DIRECT_CONTEXT_MEDIA_LIMITS.images} images. Move files to Context through file-system or remove some files.`);
            return;
        }

        if (globalState.currentMode === 'deepthink') {
            const deepthink = await ensureDeepthinkInitialized();
            await deepthink.startDeepthinkAnalysisProcess(initialIdea, globalState.directContextFiles);
        } else if (globalState.currentMode === 'contextual') {
            const contextual = await ensureContextualInitialized();
            await contextual.startContextualProcess(initialIdea, globalState.customPromptsContextualState);
        } else if (globalState.currentMode === 'adaptive-deepthink') {
            const adaptive = await ensureAdaptiveDeepthinkInitialized();
            await adaptive.startAdaptiveDeepthinkProcess(initialIdea, globalState.customPromptsAdaptiveDeepthinkState, globalState.directContextFiles);
        } else {
            throw new Error(`Unknown or unsupported application mode: ${globalState.currentMode}`);
        }
    }

    public static async handleResumeDeepthink() {
        if (!hasValidApiKey()) {
            alert("No providers are configured. Please configure at least one AI provider using the 'Add Providers' button.");
            return;
        }
        const deepthink = await ensureDeepthinkInitialized();
        await deepthink.resumeDeepthinkAnalysisProcess();
    }

    public static handleExportConfig() {
        exportConfiguration();
    }

    public static handleImportConfig(e: Event) {
        handleImportConfiguration(e);
    }
}
