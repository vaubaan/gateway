/**
 * What each tool of the `supabase` service does, in a few words a person reads at
 * a glance (`ServicePlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

import { TOOL } from './identity.ts';

export const supabaseToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listProjects]: 'List the projects of the mission',
  [TOOL.getProject]: 'Read the project',
  [TOOL.getAnonKey]: 'Read the API URL and the anonymous key',
  [TOOL.listTables]: 'List tables',
  [TOOL.listMigrations]: 'List applied migrations',
  [TOOL.executeSql]: 'Run a read-only SQL query',
  [TOOL.getAdvisors]: 'Read the advisors',
  [TOOL.applyMigration]: 'Apply a database migration',
  [TOOL.listBranches]: 'List preview branches',
  [TOOL.getBranch]: "Read a preview branch's database settings",
  [TOOL.deleteBranch]: 'Delete a preview branch',
  [TOOL.resetBranch]: 'Reset a preview branch',
  [TOOL.listBuckets]: 'List storage buckets',
  [TOOL.getStorageConfig]: 'Read the storage configuration',
  [TOOL.updateStorageConfig]: 'Change the storage configuration',
  [TOOL.getAuthConfig]: 'Read the sign-in configuration',
  [TOOL.updateAuthConfig]: 'Change the sign-in configuration',
  [TOOL.listSsoProviders]: 'List SSO providers',
  [TOOL.getSsoProvider]: 'Read an SSO provider',
  [TOOL.createSsoProvider]: 'Register an SSO provider',
  [TOOL.updateSsoProvider]: 'Change an SSO provider',
  [TOOL.deleteSsoProvider]: 'Delete an SSO provider',
  [TOOL.listThirdPartyAuth]: 'List third-party sign-in providers',
  [TOOL.getThirdPartyAuth]: 'Read a third-party sign-in provider',
  [TOOL.createThirdPartyAuth]: 'Register a third-party sign-in provider',
  [TOOL.deleteThirdPartyAuth]: 'Delete a third-party sign-in provider',
  [TOOL.listFunctions]: 'List edge functions',
  [TOOL.getFunction]: 'Read an edge function',
  [TOOL.getFunctionBody]: 'Read the source of an edge function',
  [TOOL.createFunction]: 'Create an edge function',
  [TOOL.updateFunction]: 'Change an edge function',
  [TOOL.deleteFunction]: 'Delete an edge function',
  [TOOL.deployFunction]: 'Deploy an edge function',
  [TOOL.listFunctionSecrets]: 'List the names of function secrets',
  [TOOL.createFunctionSecrets]: 'Set function secrets',
  [TOOL.deleteFunctionSecrets]: 'Delete function secrets',
  [TOOL.listUsers]: 'List users',
  [TOOL.getUser]: 'Read a user',
  [TOOL.createUser]: 'Create a user',
  [TOOL.updateUser]: 'Change a user',
  [TOOL.deleteUser]: 'Delete a user',
  [TOOL.generateLink]: 'Generate a one-time sign-in link',
  [TOOL.createBucket]: 'Create a storage bucket',
  [TOOL.updateBucket]: 'Change a storage bucket',
  [TOOL.deleteBucket]: 'Delete a storage bucket',
  [TOOL.listObjects]: 'List the objects of a bucket',
  [TOOL.uploadObject]: 'Upload an object',
  [TOOL.deleteObject]: 'Delete an object',
  [TOOL.createSignedUrl]: 'Create a signed URL for an object',
};
