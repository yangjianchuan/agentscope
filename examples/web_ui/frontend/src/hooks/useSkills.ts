import { useCallback, useEffect, useState } from 'react';

import { skillApi } from '@/api';
import type { SkillView } from '@/api';

/**
 * The user's library of installed skills.
 *
 * User-level, so unlike `useWorkspace` it needs no agent/session — an empty
 * list means the user has installed nothing yet, not that a session is
 * missing.
 */
export function useSkills() {
	const [skills, setSkills] = useState<SkillView[]>([]);
	// Starts true: the first paint happens before the effect fires, and
	// a false start would flash the empty state before the spinner.
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);

	const refetch = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setSkills(await skillApi.list());
		} catch (e) {
			setError(e as Error);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refetch();
	}, [refetch]);

	const remove = useCallback(
		async (skillId: string) => {
			await skillApi.remove(skillId);
			await refetch();
		},
		[refetch],
	);

	const setEnabled = useCallback(async (skillId: string, enabled: boolean) => {
		const updated = await skillApi.update(skillId, { enabled });
		setSkills((current) =>
			current.map((skill) => (skill.id === skillId ? updated : skill)),
		);
	}, []);

	const openFolder = useCallback(
		async (skillId: string) => skillApi.openFolder(skillId),
		[],
	);

	return { skills, loading, error, refetch, remove, setEnabled, openFolder };
}
