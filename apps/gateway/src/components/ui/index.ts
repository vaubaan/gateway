/**
 * The design system of the interface (spec `docs/spec/style-guide.md`,
 * handbook `docs/handbook/web-app.md`). Every page is built from these; a
 * component a page misses is added here, never in the page. The gallery at
 * `/design` shows each one in every state, in both themes.
 */

// The frame of a page
export {
  PageHeader,
  Crumbs,
  Section,
  SectionHeading,
  SummaryLine,
  KeyValue,
  Stats,
  Hint,
  type Crumb,
  type PageWidth,
  type Stat,
  type SummaryItem,
} from './Page.tsx';
export { DocHint, DocsProvider } from './DocHint.tsx';
export { SubNav, SubNavFrame, type SubNavGroup, type SubNavItem } from './SubNav.tsx';
export { Container, Stack } from './Layout.tsx';
export { Card, CardHeader, CardTitle, CardBody, CardFooter } from './Card.tsx';

// Lists and tables
export { Rows, Row } from './List.tsx';
export {
  DataTable,
  checkColumnBudget,
  DEFAULT_COLUMN_BUDGET,
  DETAIL_COLUMN_BUDGET,
  type Column,
  type DataTableProps,
  type RowGroup,
  type RowTone,
} from './Table.tsx';
export { Meter, meterState, NEAR_LIMIT, type MeterState } from './Meter.tsx';

// Marks: state, who, what
export { StatusMark, Dot, Tag, EnvTag, toneOfBadge, type BadgeTone, type Tone } from './Badge.tsx';
export {
  Avatar,
  AvatarStack,
  KeyHolder,
  ServiceMark,
  KeyMark,
  AgentLabel,
  darkThemeMarkColor,
  hueOf,
  initialsOf,
  serviceLetters,
  type AvatarSize,
  type HolderKind,
  type ServiceMarkIcon,
  type StackMember,
} from './Avatar.tsx';
export { Mono } from './Mono.tsx';
export { RowChip, GateMark, WhyCells } from './Marks.tsx';
export { Icon, type IconName } from './Icon.tsx';

// Permissions and what a mission allows
export {
  PermissionTable,
  PermissionGroup,
  PermissionRow,
  type PermissionVariant,
  type PermissionWhy,
} from './Permission.tsx';
export { AllowSummary } from './Allow.tsx';

// What needs the person, and what a page shows when it has nothing
export { AnswerList, AnswerRow } from './Answer.tsx';
export {
  EmptyState,
  Lede,
  ModelDiagram,
  StepMark,
  CheckMark,
  Skeleton,
  type CheckState,
  type ModelNode,
  type StepState,
} from './States.tsx';
export { Callout } from './Callout.tsx';

// Actions and overlays
export {
  Button,
  ButtonLink,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from './Button.tsx';
export {
  Dialog,
  DialogPanel,
  ConfirmDialog,
  DangerConfirm,
  OptionCard,
  type ConfirmOption,
} from './Dialog.tsx';
export { ToastProvider, ToastCard, useToast, type ToastMessage } from './Toast.tsx';
export { CopyButton } from './CopyButton.tsx';

// Details on demand, and narrowing a list
export { Disclosure, DetailScope, DetailToggle, DetailOnly, useRemembered } from './Disclosure.tsx';
export { TabList, TabPanel, type TabItem } from './Tabs.tsx';
export { Segmented, FilterChips, SearchField, type FilterOption } from './Filter.tsx';

// Forms and technical text
export { Input, Textarea, Select, Checkbox, Radio, Switch, Field } from './Input.tsx';
export { Code, CodeBlock, CodeTone } from './Code.tsx';

// Added with the pages (R2c): accounts, activity, settings
export { PickGrid, PickCard } from './Pick.tsx';
export { ConfirmSubmit } from './ConfirmSubmit.tsx';

// What is running, the inbox and one open request (the home, "Waiting for you")
export { RunList, RunRow } from './Running.tsx';
export { InboxFrame, InboxList, InboxItem } from './Inbox.tsx';
export {
  RequestStatement,
  CallBox,
  ArgList,
  FactColumns,
  DecideBar,
  ContextColumns,
  Feed,
  FeedEvent,
  type ArgItem,
  type Fact,
  type FeedTone,
} from './Request.tsx';
// Added with the mission pages: the rest behind "···", a choice among trust levels, a key shown
// once, a form with its rail
export { MoreMenu, MenuItem } from './Menu.tsx';
export { ChoiceRow, ChoiceChip } from './Choice.tsx';
export { SecretBox } from './Secret.tsx';
export { FormWithRail, FormStep, FormColumns } from './Form.tsx';
export { TrailProvider, TrailSetter, textOf, useTrail, type TrailItem } from './Trail';
