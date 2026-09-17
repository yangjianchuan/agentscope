import { useState, useCallback } from 'react';
import { modelApi } from '../api';
import type { ModelCard } from '../api';

export function useModels() {
    const [models, setModels] = useState<ModelCard[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const fetch = useCallback(async (provider: string, credentialId?: string) => {
        setLoading(true); setError(null);
        try { const res = await modelApi.list(provider, credentialId); setModels(res.models); }
        catch (e) { setError(e as Error); }
        finally { setLoading(false); }
    }, []);
    return { models, loading, error, fetch };
}
