import type { ToolItem } from "@harbour/protocol";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Section, Sheet } from "../workbench/specimen.tsx";
import { EXAMPLE_GENERATED_IMAGE } from "./fixture-generated-image.ts";
import { GeneratedImages, ImagePlaceholder } from "./generated-image.tsx";

export default { title: "Session/Generated images" } satisfies StoryDefault;

const file = {
	workspaceId: "ws_1",
	path: "images/a-man-on-a-pogo-stick-mhd0k2pq.jpg",
	name: "a-man-on-a-pogo-stick-mhd0k2pq.jpg",
	mimeType: "image/jpeg",
	size: 2_340_000,
	model: "gpt-image-2.5-flare",
};

const made = (count: number, pictures: boolean): ToolItem => ({
	kind: "tool",
	id: `made-${count}-${pictures}`,
	callId: "c1",
	at: 0,
	name: "generate_image",
	label: count === 1 ? "Making an image" : `Making ${count} images`,
	status: "done",
	files: Array.from({ length: count }, (_, index) => ({
		...file,
		path: file.path.replace(".jpg", `-${index + 1}.jpg`),
		name: file.name.replace(".jpg", `-${index + 1}.jpg`),
	})),
	...(pictures
		? {
				images: Array.from({ length: count }, () => ({
					mimeType: "image/jpeg" as const,
					data: EXAMPLE_GENERATED_IMAGE,
				})),
			}
		: {}),
});

export const Placeholders: Story = () => (
	<Sheet
		title="Generated image placeholders"
		intro="While generate_image runs: a frame the shape of each image to come, a light crossing it and its icon breathing. Transform and opacity only, so the compositor runs it; still under reduced motion."
	>
		<Section title="Square, landscape and portrait">
			<div className="hb-generated-images">
				<ImagePlaceholder aspect="square" />
				<ImagePlaceholder aspect="landscape" />
				<ImagePlaceholder aspect="portrait" />
			</div>
		</Section>
	</Sheet>
);

export const Cards: Story = () => (
	<Sheet
		title="Generated image cards"
		intro="Each image a call made, under the work: the picture, its name and the model that made it. Pressing one opens it in the viewer; the open one has an accent border."
	>
		<Section title="One image">
			<GeneratedImages item={made(1, true)} onOpen={() => {}} />
		</Section>
		<Section title="Two images, the first open">
			<GeneratedImages item={made(2, true)} onOpen={() => {}} openKey={`ws_1:${file.path.replace(".jpg", "-1.jpg")}`} />
		</Section>
		<Section title="No picture to show: a file's card, with the model">
			<GeneratedImages item={made(1, false)} onOpen={() => {}} />
		</Section>
	</Sheet>
);
