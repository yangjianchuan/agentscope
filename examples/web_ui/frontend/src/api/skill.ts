import { client } from './client';
import type { SkillRecord, SkillView, UpdateSkillRequest } from './types';

/**
 * The user's own library of installed skills, which is where a hub install
 * lands. Separate from `workspaceApi.skill`, which manages the skills one
 * session's workspace actually holds.
 */
export const skillApi = {
	list: () => client.get<SkillView[]>('/skill'),

	/** Unlike the list endpoint, this also carries the `SKILL.md` body. */
	get: (skillId: string) => client.get<SkillRecord>(`/skill/${encodeURIComponent(skillId)}`),

	/** Enable or disable an installed skill. */
	update: (skillId: string, body: UpdateSkillRequest) =>
		client.patch<SkillView>(`/skill/${encodeURIComponent(skillId)}`, body),

	/** Ask the local server to reveal the trusted skill directory. */
	openFolder: (skillId: string) =>
		client.post<void>(`/skill/${encodeURIComponent(skillId)}/open-folder`),

	/**
	 * Removes it from the library. Workspaces that already hold this skill
	 * keep their copy — the files were extracted into the workspace, and this
	 * record was only where they came from.
	 */
	remove: (skillId: string) => client.delete(`/skill/${encodeURIComponent(skillId)}`),
};
