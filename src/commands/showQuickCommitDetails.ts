'use strict';
import * as paths from 'path';
import { commands, TextEditor, Uri } from 'vscode';
import { GlyphChars } from '../constants';
import { Container } from '../container';
import { GitCommit, GitLog, GitLogCommit, GitRepoSearchBy, GitUri } from '../git/gitService';
import { Logger } from '../logger';
import { Messages } from '../messages';
import { CommandQuickPickItem, CommitQuickPick, CommitWithFileStatusQuickPickItem } from '../quickpicks';
import { Strings } from '../system';
import {
    ActiveEditorCachedCommand,
    command,
    CommandContext,
    Commands,
    getCommandUri,
    isCommandViewContextWithCommit
} from './common';
import { ShowQuickCommitFileDetailsCommandArgs } from './showQuickCommitFileDetails';

export interface ShowQuickCommitDetailsCommandArgs {
    sha?: string;
    commit?: GitCommit | GitLogCommit;
    repoLog?: GitLog;
    showInView?: boolean;

    goBackCommand?: CommandQuickPickItem;
}

@command()
export class ShowQuickCommitDetailsCommand extends ActiveEditorCachedCommand {
    static getMarkdownCommandArgs(sha: string): string;
    static getMarkdownCommandArgs(args: ShowQuickCommitDetailsCommandArgs): string;
    static getMarkdownCommandArgs(argsOrSha: ShowQuickCommitDetailsCommandArgs | string): string {
        const args = typeof argsOrSha === 'string' ? { sha: argsOrSha } : argsOrSha;
        return super.getMarkdownCommandArgsCore<ShowQuickCommitDetailsCommandArgs>(
            Commands.ShowQuickCommitDetails,
            args
        );
    }

    constructor() {
        super([Commands.ShowCommitInView, Commands.ShowQuickCommitDetails]);
    }

    protected async preExecute(context: CommandContext, args: ShowQuickCommitDetailsCommandArgs = {}): Promise<any> {
        if (context.command === Commands.ShowCommitInView) {
            args = { ...args };
            args.showInView = true;
        }

        if (context.type === 'viewItem') {
            args = { ...args };
            args.sha = context.node.uri.sha;

            if (isCommandViewContextWithCommit(context)) {
                args.commit = context.node.commit;
            }
        }

        return this.execute(context.editor, context.uri, args);
    }

    async execute(editor?: TextEditor, uri?: Uri, args: ShowQuickCommitDetailsCommandArgs = {}) {
        uri = getCommandUri(uri, editor);
        if (uri == null) return undefined;

        const gitUri = await GitUri.fromUri(uri);

        let repoPath = gitUri.repoPath;
        let workingFileName = repoPath ? paths.relative(repoPath, gitUri.fsPath) : gitUri.fsPath;

        args = { ...args };
        if (args.sha === undefined) {
            if (editor == null) return undefined;

            const blameline = editor.selection.active.line;
            if (blameline < 0) return undefined;

            try {
                const blame = await Container.git.getBlameForLine(gitUri, blameline);
                if (blame === undefined) {
                    return Messages.showFileNotUnderSourceControlWarningMessage('Unable to show commit details');
                }

                // Because the previous sha of an uncommitted file isn't trust worthy we just have to kick out
                if (blame.commit.isUncommitted) {
                    return Messages.showLineUncommittedWarningMessage('Unable to show commit details');
                }

                args.sha = blame.commit.sha;
                repoPath = blame.commit.repoPath;
                workingFileName = blame.commit.fileName;

                args.commit = blame.commit;
            }
            catch (ex) {
                Logger.error(ex, 'ShowQuickCommitDetailsCommand', `getBlameForLine(${blameline})`);
                return Messages.showGenericErrorMessage('Unable to show commit details');
            }
        }

        try {
            if (args.commit === undefined || args.commit.isFile) {
                if (args.repoLog !== undefined) {
                    args.commit = args.repoLog.commits.get(args.sha!);
                    // If we can't find the commit, kill the repoLog
                    if (args.commit === undefined) {
                        args.repoLog = undefined;
                    }
                }

                if (args.repoLog === undefined) {
                    const log = await Container.git.getLog(repoPath!, { maxCount: 2, ref: args.sha });
                    if (log === undefined) {
                        return Messages.showCommitNotFoundWarningMessage(`Unable to show commit details`);
                    }

                    args.commit = log.commits.get(args.sha!);
                }
            }

            if (args.commit === undefined) {
                return Messages.showCommitNotFoundWarningMessage(`Unable to show commit details`);
            }

            if (args.commit.workingFileName === undefined) {
                args.commit.workingFileName = workingFileName;
            }

            if (args.showInView) {
                void (await Container.searchView.search(repoPath!, args.commit.sha, GitRepoSearchBy.Sha, {
                    label: { label: `commits with an id matching '${args.commit.shortSha}'` }
                }));

                return undefined;
            }

            if (args.goBackCommand === undefined) {
                const branch = await Container.git.getBranch(args.commit.repoPath);
                if (branch !== undefined) {
                    // Create a command to get back to the branch history
                    args.goBackCommand = new CommandQuickPickItem(
                        {
                            label: `go back ${GlyphChars.ArrowBack}`,
                            description: `${Strings.pad(GlyphChars.Dash, 2, 3)} to ${branch.name} history`
                        },
                        Commands.ShowQuickCurrentBranchHistory,
                        [args.commit.toGitUri()]
                    );
                }
            }

            // Create a command to get back to where we are right now
            const currentCommand = new CommandQuickPickItem(
                {
                    label: `go back ${GlyphChars.ArrowBack}`,
                    description: `${Strings.pad(GlyphChars.Dash, 2, 3)} to details of ${
                        GlyphChars.Space
                    }$(git-commit) ${args.commit.shortSha}`
                },
                Commands.ShowQuickCommitDetails,
                [args.commit.toGitUri(), args]
            );

            const pick = await CommitQuickPick.show(
                args.commit as GitLogCommit,
                uri,
                args.goBackCommand,
                currentCommand,
                args.repoLog
            );
            if (pick === undefined) return undefined;

            if (!(pick instanceof CommitWithFileStatusQuickPickItem)) return pick.execute();

            return commands.executeCommand(Commands.ShowQuickCommitFileDetails, pick.commit.toGitUri(), {
                commit: pick.commit,
                sha: pick.sha,
                goBackCommand: currentCommand
            } as ShowQuickCommitFileDetailsCommandArgs);
        }
        catch (ex) {
            Logger.error(ex, 'ShowQuickCommitDetailsCommand');
            return Messages.showGenericErrorMessage('Unable to show commit details');
        }
    }
}
