'use client';

/**
 * Gallery, part four: what the home and "Waiting for you" are built from — the
 * list of what is running, the inbox, and one open request. Every value is
 * invented.
 */
import {
  AgentLabel,
  ArgList,
  Avatar,
  AvatarStack,
  Button,
  CallBox,
  Code,
  ContextColumns,
  DecideBar,
  FactColumns,
  Feed,
  FeedEvent,
  GateMark,
  Hint,
  InboxFrame,
  InboxItem,
  InboxList,
  Meter,
  Mono,
  RequestStatement,
  RunList,
  RunRow,
  SeverityChip,
  StatusMark,
} from '@/components/ui';

import { GallerySection, Specimen } from './specimen';

export function WaitingSections() {
  return (
    <>
      <GallerySection
        id="running"
        title="Running list"
        rule="One line per mission: where it works and who holds a key, the marks of the holders, one figure — a meter only near a limit, a mark for the exception — and when it last did something. Columns, so that the list reads down as well as across."
      >
        <Specimen name="A meter near the limit, a dash, a limit reached">
          {() => (
            <RunList label="Running now">
              <RunRow
                title="Ship the billing page"
                href="#running"
                facts="GitHub · Supabase · you, Carol, machine key nightly"
                holders={
                  <AvatarStack
                    members={[
                      { name: 'Alice Chen' },
                      { name: 'Carol Diaz' },
                      { name: 'nightly', kind: 'machine' },
                    ]}
                  />
                }
                figure={<Meter used={1860} limit={3000} format="percent" label="branch writes" />}
                last="2 min"
              />
              <RunRow
                title="Release 2.4 hotfix"
                href="#running"
                facts="GitHub · you"
                holders={<AvatarStack members={[{ name: 'Alice Chen' }]} />}
                figure={<Meter used={58} limit={10000} format="percent" label="reads" />}
                last="14 min"
              />
              <RunRow
                title="Nightly dependency audit"
                href="#running"
                facts="GitHub · machine key nightly"
                holders={<AvatarStack members={[{ name: 'nightly', kind: 'machine' }]} />}
                figure={<StatusMark tone="bad">Limit reached</StatusMark>}
                last="1 h"
              />
            </RunList>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="inbox"
        title="Inbox"
        rule="One list, one item open beside it. The open item is a fill, not a colour; each item is a link to its own address."
      >
        <Specimen name="Two items, the first one open">
          {() => (
            <InboxFrame
              list={
                <InboxList
                  label="Open requests"
                  footer="In the last 24 hours: 3 approved, 1 refused."
                >
                  <InboxItem
                    href="#inbox"
                    current
                    who={<Avatar name="Carol Diaz" />}
                    title="Merge to a protected branch"
                    context="Ship the billing page · Carol · codex"
                    meta="4 min ago · expires in 23 h"
                  />
                  <InboxItem
                    href="#inbox"
                    who={<Avatar name="nightly" kind="machine" />}
                    title="Daily limit reached on Read code"
                    context="Nightly dependency audit · machine key nightly"
                    meta="1 h ago · resets in 13 h anyway"
                  />
                </InboxList>
              }
            >
              <Hint>The open request is drawn here.</Hint>
            </InboxFrame>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="request"
        title="Open request"
        rule="What a person reads before answering, in this order: who asks and on which mission, the one statement, exactly what was sent, what it counts against, then the answers. Context comes after the answers."
      >
        <Specimen name="An approval" note="the statement is the focal point; one primary answer">
          {() => (
            <div>
              <RequestStatement
                verb={
                  <>
                    <AgentLabel>codex</AgentLabel> using <b>Carol’s key</b> on{' '}
                    <b>Ship the billing page</b> wants to
                  </>
                }
              >
                Merge pull request <Code>#418</Code> into <Code>main</Code>
              </RequestStatement>
              <CallBox
                label="Exactly what it sent"
                aside={
                  <>
                    tool <Mono>github__merge_pull_request</Mono>
                  </>
                }
              >
                <ArgList
                  items={[
                    { name: 'owner', value: 'acme' },
                    { name: 'repo', value: 'web' },
                    { name: 'pull_number', value: '418' },
                    { name: 'merge_method', value: 'squash' },
                  ]}
                />
              </CallBox>
              <FactColumns
                items={[
                  {
                    label: 'Permission it needs',
                    value: (
                      <>
                        <GateMark gate="ask" /> · Write on protected branches ·{' '}
                        <SeverityChip level="high" />
                      </>
                    ),
                  },
                  { label: 'Room left after this', value: '49 of 50 left today' },
                ]}
              />
              <DecideBar
                aside={
                  <Button variant="ghost" size="lg">
                    Let it run freely until the reset
                  </Button>
                }
              >
                <Button variant="primary" size="lg">
                  Approve this call
                </Button>
                <Button size="lg">Refuse</Button>
              </DecideBar>
            </div>
          )}
        </Specimen>
        <Specimen name="Answered" note="a state of its own: what became of it, and no answer">
          {() => (
            <RequestStatement
              verb={
                <>
                  <AgentLabel>codex</AgentLabel> using <b>your key</b> on <b>Release 2.4 hotfix</b>{' '}
                  wants to
                </>
              }
              status={<StatusMark>approved</StatusMark>}
            >
              Merge to a protected branch
            </RequestStatement>
          )}
        </Specimen>
        <Specimen name="What led here" note="a time, a mark that carries its word, one sentence">
          {() => (
            <ContextColumns>
              <section>
                <Feed label="What led here">
                  <FeedEvent time="10:58" tone="warn">
                    <AgentLabel>codex</AgentLabel> was stopped on{' '}
                    <Mono>github__merge_pull_request</Mono> · <Mono quiet>approval-required</Mono>
                  </FeedEvent>
                  <FeedEvent time="10:57" tone="ok">
                    <AgentLabel>codex</AgentLabel> ran <Mono>github__add_issue_comment</Mono>
                  </FeedEvent>
                  <FeedEvent time="10:41" tone="bad">
                    An agent was refused <Mono>github__delete_branch</Mono> ·{' '}
                    <Mono quiet>risk-not-accepted</Mono>
                  </FeedEvent>
                  <FeedEvent time="10:31">You set this permission to “ask me first”</FeedEvent>
                </Feed>
              </section>
            </ContextColumns>
          )}
        </Specimen>
      </GallerySection>
    </>
  );
}
