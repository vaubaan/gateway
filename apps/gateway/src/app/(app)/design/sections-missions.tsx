'use client';

/**
 * Gallery, part four: the components added with the mission pages — the rest
 * behind "···", a choice among presets, a key shown once, a form with its
 * rail. Every value is invented.
 */
import { useState } from 'react';

import {
  AllowSummary,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  ChoiceChip,
  ChoiceRow,
  Field,
  FormColumns,
  FormStep,
  FormWithRail,
  Input,
  MenuItem,
  MoreMenu,
  SecretBox,
  Select,
} from '@/components/ui';
import { ACTIONS, MISSION_ACTIONS, MISSION_WORDS } from '@/lib/vocabulary';

import { GallerySection, Line, Specimen } from './specimen';

/** The entries the local navigation of the gallery lists for this part. */
export const MISSION_SECTION_ITEMS = [
  { id: 'menu', label: 'More menu' },
  { id: 'choice', label: 'Choice chips' },
  { id: 'secret', label: 'Key shown once' },
  { id: 'form-rail', label: 'Form with a rail' },
] as const;

function Presets({ theme }: { theme: string }) {
  const [value, setValue] = useState('developer');
  return (
    <ChoiceRow legend="Preset for GitHub · acme">
      <ChoiceChip
        name={`design-preset-${theme}`}
        value="read-only"
        checked={value === 'read-only'}
        onChange={setValue}
        label="Read-only"
        hint="2"
      />
      <ChoiceChip
        name={`design-preset-${theme}`}
        value="developer"
        checked={value === 'developer'}
        onChange={setValue}
        label="Developer"
        hint="10"
      />
      <ChoiceChip
        name={`design-preset-${theme}`}
        value="operator"
        checked={value === 'operator'}
        onChange={setValue}
        label="Migration operator"
        unavailable="needs a selected resource labelled “prod”: none selected"
      />
      <ChoiceChip
        name={`design-preset-${theme}`}
        value="custom"
        checked={value === 'custom'}
        onChange={setValue}
        label="Custom"
        hint="start empty"
      />
    </ChoiceRow>
  );
}

export function MissionSections() {
  return (
    <>
      <GallerySection
        id="menu"
        title="More menu"
        rule="One primary action, at most two secondary ones visible; everything else behind “···”. An item is a verb; an act that stops something is written in red and still asks before it does anything."
      >
        <Specimen name="Closed and open" note="Escape closes it; the arrow keys move between items">
          {() => (
            <Line>
              <Button>{ACTIONS.setupKit}</Button>
              <MoreMenu>
                <MenuItem>{MISSION_ACTIONS.activity}</MenuItem>
                <MenuItem>{ACTIONS.newMachineKey}</MenuItem>
                <MenuItem note="Its creator alone can copy it" disabled>
                  {MISSION_ACTIONS.duplicate}
                </MenuItem>
                <MenuItem danger>{MISSION_ACTIONS.stop}</MenuItem>
              </MoreMenu>
            </Line>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="choice"
        title="Choice chips"
        rule="One choice among a few, each with a short fact beside it. A choice that would yield nothing is not hidden and not offered silently: it is dashed, cannot be picked, and says why."
      >
        <Specimen
          name="Presets of an account"
          note="chosen, available, unavailable with its reason"
        >
          {(theme) => <Presets theme={theme} />}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="secret"
        title="Key shown once"
        rule="A key is shown whole once, right after it was made, in the one filled box of the view. Afterwards a page shows its masked form; replacing the key is the only way to get a new one."
      >
        <Specimen name="Right after creation">
          {() => (
            <SecretBox
              label="Your key"
              value="vbn_live_EXAMPLE0_this-is-not-a-key-only-its-shape"
            />
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="form-rail"
        title="Form with a rail"
        rule="A form filled from top to bottom in numbered steps, while a rail beside it says what the result will be and holds the one primary action. The rail is the one bordered box of the page; in a narrow window it comes after the steps."
      >
        <Specimen name="Two steps and the rail">
          {(theme) => (
            <FormWithRail
              rail={
                <Card>
                  <CardHeader>
                    <CardTitle>{MISSION_WORDS.railTitle}</CardTitle>
                  </CardHeader>
                  <CardBody>
                    <AllowSummary
                      compact
                      can="Read code · Open a pull request and 6 more. 8 permissions."
                      asks="Write on main. 1 permission."
                      asksLabel="Asks you"
                      cannot="Delete a release, and anything outside its accounts and resources."
                    />
                  </CardBody>
                  <CardFooter>
                    <Button variant="primary" size="lg">
                      {ACTIONS.createMission}
                    </Button>
                  </CardFooter>
                </Card>
              }
            >
              <FormStep n={1} title="Name" hint="How you will find it again.">
                <Input
                  aria-label={`Mission name (${theme})`}
                  defaultValue="Ship the billing page"
                />
              </FormStep>
              <FormStep n={2} title="Limits and lifetime">
                <FormColumns>
                  <Field label="Limits reset" htmlFor={`design-period-${theme}`}>
                    <Select id={`design-period-${theme}`} defaultValue="day">
                      <option value="day">Every day</option>
                      <option value="week">Every week</option>
                    </Select>
                  </Field>
                  <Field label="Expires" htmlFor={`design-expiry-${theme}`}>
                    <Select id={`design-expiry-${theme}`} defaultValue="30d">
                      <option value="30d">In 30 days</option>
                      <option value="never">Never</option>
                    </Select>
                  </Field>
                  <Field label="People">
                    <span>{MISSION_WORDS.peopleLater}</span>
                  </Field>
                </FormColumns>
              </FormStep>
            </FormWithRail>
          )}
        </Specimen>
      </GallerySection>
    </>
  );
}
