import chalk from 'chalk';
import { ReactiveListChoice } from 'inquirer-reactive-list-prompt';
import { Observable, catchError, concatMap, from, map } from 'rxjs';
import { fromPromise } from 'rxjs/internal/observable/innerFrom';

import { AIResponse, AIService, AIServiceParams } from './ai.service.js';
import { RequestType } from '../../utils/ai-log.js';
import { generateCommitMessage } from '../../utils/openai.js';
import { DEFAULT_PROMPT_OPTIONS, PromptOptions, codeReviewPrompt, generatePrompt } from '../../utils/prompt.js';
import { flattenDeep } from '../../utils/utils.js';

export class OpenAIService extends AIService {
    constructor(private readonly params: AIServiceParams) {
        super(params);
        this.colors = {
            primary: '#74AA9C',
            secondary: '#FFF',
        };
        this.serviceName = chalk.bgHex(this.colors.primary).hex(this.colors.secondary).bold(`[ChatGPT]`);
        this.errorPrefix = chalk.red.bold(`[ChatGPT]`);
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
        const {
            systemPrompt,
            systemPromptPath,
            codeReviewPromptPath,
            temperature,
            logging,
            locale,
            generate,
            type,
            maxLength,
            proxy,
            maxTokens,
            timeout,
        } = this.params.config;
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

        const results = await generateCommitMessage(
            'ChatGPT',
            this.params.config.url,
            this.params.config.path,
            this.params.config.key,
            this.params.config.model,
            diff,
            timeout,
            maxTokens,
            temperature,
            this.params.config.topP,
            generatedSystemPrompt,
            logging,
            requestType,
            proxy
        );

        if (requestType === 'review') {
            return flattenDeep(results.map(value => this.sanitizeResponse(value)));
        }
        return flattenDeep(results.map(value => this.parseMessage(value, type, generate)));
    }
}
