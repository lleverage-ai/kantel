// The schedules page: the library's SchedulesPage over the console's schedules seam, with the open schedule in the URL
// (/schedules/:scheduleId) and each task run linking to the session it started. A run's session may be in any
// project, and a schedule owned by the organisation or a person doesn't say which, so the link is /sessions/:id and
// the shell finds the project.

import { type ScheduleLinks, SchedulesPage } from "@kantel/ui";
import { useRef } from "react";
import type { ConsoleSchedules } from "../api/oversight.ts";
import { navigate, schedulesPath, sessionLinkPath } from "./router.ts";

const links: ScheduleLinks = { session: (sessionId) => sessionLinkPath(sessionId) };

export function SchedulesScreen({
	schedules,
	scheduleId,
	creating = false,
}: {
	schedules: ConsoleSchedules;
	scheduleId?: string;
	creating?: boolean;
}) {
	// The page keeps the open schedule itself and reports it, which goes into the URL. A URL it didn't report (Back,
	// Forward, a pasted link) opens the page afresh on that schedule.
	const shown = useRef<{ id: string | undefined; generation: number }>({ id: scheduleId, generation: 0 });
	if (shown.current.id !== scheduleId) shown.current = { id: scheduleId, generation: shown.current.generation + 1 };

	return (
		<SchedulesPage
			key={shown.current.generation}
			source={schedules.source}
			directory={schedules.directory}
			links={links}
			{...(schedules.form === undefined ? {} : { form: schedules.form })}
			{...(schedules.now === undefined ? {} : { now: schedules.now })}
			{...(scheduleId === undefined ? {} : { initialSelected: scheduleId, initialFilter: "all" as const })}
			initialNew={creating}
			onSelect={(id) => {
				shown.current = { ...shown.current, id };
				navigate(schedulesPath(id));
			}}
		/>
	);
}
