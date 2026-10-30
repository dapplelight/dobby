/** First run shows only while there is no project: the snapshot's project list is empty. Undefined (not loaded yet) is not a first run. */
export const firstRun = (projects: readonly string[] | undefined) => projects !== undefined && projects.length === 0
