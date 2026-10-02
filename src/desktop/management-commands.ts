export const managementCommands = ['updateTask', 'archiveTask', 'updateProject', 'deleteProject', 'reorderTasks', 'reorderProjects', 'checkIn', 'movePlan', 'repeatPlan', 'manageCategories'] as const;
export type ManagementCommand = typeof managementCommands[number];
