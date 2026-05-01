// Stream-json message shapes emitted by `claude -p --output-format stream-json --verbose`.
// These mirror the wire format; field names match exactly so JSON.parse → cast works.

export type StreamMessage =
	| SystemMessage
	| UserMessage
	| AssistantMessage
	| ResultMessage;

export interface SystemMessage {
	type: "system";
	subtype?: string;
	session_id?: string;
	cwd?: string;
	model?: string;
	tools?: string[];
	[key: string]: unknown;
}

export interface UserMessage {
	type: "user";
	message: {
		role: "user";
		content: ContentBlock[];
	};
	session_id?: string;
}

export interface AssistantMessage {
	type: "assistant";
	message: {
		id?: string;
		role: "assistant";
		model?: string;
		content: ContentBlock[];
		stop_reason?: string | null;
		usage?: Usage;
	};
	session_id?: string;
}

export interface ResultMessage {
	type: "result";
	subtype?: string;
	duration_ms?: number;
	num_turns?: number;
	session_id?: string;
	total_cost_usd?: number;
	usage?: Usage;
	result?: string;
	is_error?: boolean;
}

export type ContentBlock =
	| TextBlock
	| ThinkingBlock
	| ToolUseBlock
	| ToolResultBlock
	| ImageBlock
	| DocumentBlock;

export interface ImageBlock {
	type: "image";
	source: {
		type: "base64";
		media_type: string;
		data: string;
	};
}

export interface DocumentBlock {
	type: "document";
	source: {
		type: "base64";
		media_type: string;
		data: string;
	};
}

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface ToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface ToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string | ContentBlock[];
	is_error?: boolean;
}

export interface Usage {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}
