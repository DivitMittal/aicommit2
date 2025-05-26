import { AxiosResponse } from 'axios';
import chalk from 'chalk';
import { ReactiveListChoice } from 'inquirer-reactive-list-prompt';
import { Observable, catchError, concatMap, from, map } from 'rxjs';
import { fromPromise } from 'rxjs/internal/observable/innerFrom';

import { AIResponse, AIService, AIServiceParams } from './ai.service.js';
import { RequestType, createLogResponse } from '../../utils/ai-log.js';
import { DEFAULT_PROMPT_OPTIONS, PromptOptions, codeReviewPrompt, generatePrompt } from '../../utils/prompt.js';
import { HttpRequestBuilder } from '../http/http-request.builder.js';

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

export class PerplexityService extends AIService {
    private host = 'https://api.perplexity.ai';
    private apiKey = '';

    constructor(private readonly params: AIServiceParams) {
        super(params);
        this.colors = {
            primary: '#20808D',
            secondary: '#FFF',
        };
        this.serviceName = chalk.bgHex(this.colors.primary).hex(this.colors.secondary).bold(`[Perplexity]`);
        this.errorPrefix = chalk.red.bold(`[Perplexity]`);
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

    private extractJSONFromError(error: string) {
        const regex = /[{[]{1}([,:{}[\]0-9.\-+Eaeflnr-u \n\r\t]|".*?")+[}\]]{1}/gis;
        const matches = error.match(regex);
        if (matches) {
            return Object.assign({}, ...matches.map((m: any) => JSON.parse(m)));
        }
        return {
            error: {
                message: 'Unknown error',
            },
        };
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
        const chatResponse = await this.createChatCompletions(generatedSystemPrompt, diff);
        logging && createLogResponse('Perplexity', diff, generatedSystemPrompt, chatResponse, requestType);
        return this.parseMessage(chatResponse, type, generate);
    }

    private async createChatCompletions(systemPrompt: string, diff: string): Promise<string> {
        const response: AxiosResponse<CreateChatCompletionsResponse> = await new HttpRequestBuilder({
            method: 'POST',
            baseURL: `${this.host}/chat/completions`,
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
                        content: `${systemPrompt}`,
                    },
                    {
                        role: 'user',
                        content: `Here is the diff: ${diff}`,
                    },
                ],
                temperature: this.params.config.temperature,
                top_p: this.params.config.topP,
                max_tokens: this.params.config.maxTokens,
                stream: false,
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
