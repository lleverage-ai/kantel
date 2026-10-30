import type { ToolItem } from "@harbour/protocol";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Section, Sheet } from "../workbench/specimen.tsx";
import { EXAMPLE_GENERATED_IMAGE } from "./fixture-generated-image.ts";
import { GeneratedImages, generatedImagesFrame, ImagePlaceholder } from "./generated-image.tsx";

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
			<div className={generatedImagesFrame}>
				<ImagePlaceholder aspect="square" />
				<ImagePlaceholder aspect="landscape" />
				<ImagePlaceholder aspect="portrait" />
			</div>
		</Section>
	</Sheet>
);

// The host's read of a file the call returned no picture of: the example image, or one still being read.
const previewed = (): Promise<string | undefined> =>
	Promise.resolve(`data:image/jpeg;base64,${EXAMPLE_GENERATED_IMAGE}`);
const reading = (): Promise<string | undefined> => new Promise(() => {});
const noPicture = (): Promise<string | undefined> => Promise.resolve(undefined);

export const Cards: Story = () => (
	<Sheet
		title="Generated image cards"
		intro="Each image a call made, under the work, as a tile: the picture cropped to a square, its name and the model that made it. Pressing one opens it whole in the viewer; the open one has an accent border. A tile's size comes from the grid, never from its picture: one alone up to 336px, two or more four to a row, and two to a row on a phone."
	>
		<Section title="One image">
			<GeneratedImages item={made(1, true)} onOpen={() => {}} />
		</Section>
		<Section title="Two images, the first open">
			<GeneratedImages item={made(2, true)} onOpen={() => {}} openKey={`ws_1:${file.path.replace(".jpg", "-1.jpg")}`} />
		</Section>
		<Section title="Four images">
			<GeneratedImages item={made(4, true)} onOpen={() => {}} />
		</Section>
		<Section title="Four images too large to return: the host's read of each, the same tiles">
			<GeneratedImages item={made(4, false)} onOpen={() => {}} previewImage={previewed} />
		</Section>
		<Section title="While the host reads them, and when it has no picture">
			<GeneratedImages item={made(2, false)} onOpen={() => {}} previewImage={reading} />
			<GeneratedImages item={made(1, false)} onOpen={() => {}} previewImage={noPicture} />
		</Section>
		<Section title="No host to read it: a file's card, with the model">
			<GeneratedImages item={made(1, false)} onOpen={() => {}} />
		</Section>
	</Sheet>
);
