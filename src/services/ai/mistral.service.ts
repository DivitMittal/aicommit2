import { AxiosResponse } from 'axios';
import chalk from 'chalk';
import { ReactiveListChoice } from 'inquirer-reactive-list-prompt';
import { Observable, catchError, concatMap, from, map } from 'rxjs';
import { fromPromise } from 'rxjs/internal/observable/innerFrom';

import { AIResponse, AIService, AIServiceError, AIServiceParams } from './ai.service.js';
import { RequestType, createLogResponse } from '../../utils/ai-log.js';
import { DEFAULT_PROMPT_OPTIONS, PromptOptions, codeReviewPrompt, generatePrompt } from '../../utils/prompt.js';
import { getRandomNumber } from '../../utils/utils.js';
import { HttpRequestBuilder } from '../http/http-request.builder.js';

export interface MistralServiceError extends AIServiceError {}

export interface ListAvailableModelsResponse {
    object: string;
    data: {
        id: string;
        object: string;
        created: number;
        owned_by: string;
    }[];
}

export interface CreateChatCompletionsResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: {
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }[];
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export class MistralService extends AIService {
    private host = `https://api.mistral.ai`;
    private apiKey = '';

    constructor(private readonly params: AIServiceParams) {
        super(params);
        this.colors = {
            primary: '#ff7000',
            secondary: '#fff',
        };
        this.serviceName = chalk.bgHex(this.colors.primary).hex(this.colors.secondary).bold('[MistralAI]');
        this.errorPrefix = chalk.red.bold(`[MistralAI]`);
        this.apiKey = this.params.config.key;
    }

    generateCommitMessage$(): Observable<ReactiveListChoice> {
        return fromPromise(this.generateMessage('commit')).pipe(
            concatMap(messages => from(messages)),
            map(data => ({
                name: `${this.serviceName} ${data.title}`,
                short: data.title,
                value: this.params.config.includeBody ? data.value : data.title,
                description: this.params.config.includeBody ? data.value : '',
                isError: false,
            })),
            catchError(this.handleError$)
        );
    }

    generateCodeReview$(): Observable<ReactiveListChoice> {
        return fromPromise(this.generateMessage('review')).pipe(
            concatMap(messages => from(messages)),
            map(data => ({
                name: `${this.serviceName} ${data.title}`,
                short: data.title,
                value: data.value,
                description: data.value,
                isError: false,
            })),
            catchError(this.handleError$)
        );
    }

    private async generateMessage(requestType: RequestType): Promise<AIResponse[]> {
        const diff = this.params.stagedDiff.diff;
        const { systemPrompt, systemPromptPath, codeReviewPromptPath, logging, locale, generate, type, maxLength } = this.params.config;
        const promptOptions: PromptOptions = {
            ...DEFAULT_PROMPT_OPTIONS,
            locale,
            maxLength,
            type,
            generate,
            systemPrompt,
            systemPromptPath,
            codeReviewPromptPath,
        };
        const generatedSystemPrompt = requestType === 'review' ? codeReviewPrompt(promptOptions) : generatePrompt(promptOptions);

        await this.checkAvailableModels();
        const chatResponse = await this.createChatCompletions(generatedSystemPrompt, `Here is the diff: ${diff}`);
        logging && createLogResponse('MistralAI', diff, generatedSystemPrompt, chatResponse, requestType);
        if (requestType === 'review') {
            return this.sanitizeResponse(chatResponse);
        }
        return this.parseMessage(chatResponse, type, generate);
    }

    private async checkAvailableModels() {
        const availableModels = await this.getAvailableModels();
        if (availableModels.includes(this.params.config.model)) {
            return true;
        }
        throw new Error(`Invalid model type of Mistral AI: ${this.params.config.model}`);
    }

    private async getAvailableModels() {
        const response: AxiosResponse<ListAvailableModelsResponse> = await new HttpRequestBuilder({
            method: 'GET',
            baseURL: `${this.host}/v1/models`,
            timeout: this.params.config.timeout,
        })
            .setHeaders({
                Authorization: `Bearer ${this.apiKey}`,
                'content-type': 'application/json',
            })
            .execute();

        return response.data.data.filter(model => model.object === 'model').map(model => model.id);
    }

    private async createChatCompletions(systemPrompt: string, userMessage: string) {
        const response: AxiosResponse<CreateChatCompletionsResponse> = await new HttpRequestBuilder({
            method: 'POST',
            baseURL: `${this.host}/v1/chat/completions`,
            timeout: this.params.config.timeout,
        })
            .setHeaders({
                Authorization: `Bearer ${this.apiKey}`,
                'content-type': 'application/json',
            })
            .setBody({
                model: this.params.config.model,
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt,
                    },
                    {
                        role: 'user',
                        content: userMessage,
                    },
                ],
                temperature: this.params.config.temperature,
                top_p: this.params.config.topP,
                max_tokens: this.params.config.maxTokens,
                stream: false,
                safe_prompt: false,
                random_seed: getRandomNumber(10, 1000),
            })
            .execute();
        const result: CreateChatCompletionsResponse = response.data;
        const hasNoChoices = !result.choices || result.choices.length === 0;
        if (hasNoChoices || !result.choices[0].message?.content) {
            throw new Error(`No Content on response. Please open a Bug report`);
        }
        return result.choices[0].message.content;
    }
}
