import type {
    DeepthinkPipelineState
} from '../Deepthink/core/deepthinkCore';

export type {
    DeepthinkPipelineState
};

export interface FileData {
    base64: string;
    mimeType: string;
    name: string;
    size: number;
}
