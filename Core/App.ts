import { exportConfiguration, handleImportConfiguration } from './ConfigManager';
import { updateUIAfterModeChange } from './AppRouter';
import { ensureDeepthinkInitialized } from './ModeLoader';
import { routingManager, initializeRouting, hasValidApiKey } from '../Routing';
import { globalState } from './State';
import { updateControlsState } from '../UI/Controls';
import { LayoutController } from '../UI/LayoutController';
import { countFileTokens, getMediaCounts, DIRECT_CONTEXT_MEDIA_LIMITS, DIRECT_CONTEXT_TOKEN_LIMIT } from '../Styles/Components/Sidebar/FileUpload';

export class App {
    public static init() {
        initializeRouting();
        routingManager.refreshProviders();
        routingManager.initializePromptsManager({ current: globalState.customPromptsDeepthinkState });
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

        const deepthink = await ensureDeepthinkInitialized();
        await deepthink.startDeepthinkAnalysisProcess(initialIdea, globalState.directContextFiles);
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

