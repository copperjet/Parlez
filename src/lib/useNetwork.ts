/**
 * Network reachability (spec §10.2, §11.3). Drives the offline banner and the
 * "full conversation needs internet" degradation.
 *
 * Backed by expo-network (an Expo SDK module) rather than a community native
 * module so it builds cleanly under the new architecture. `useNetworkState`
 * sets up a listener and cleans up on unmount.
 */
import { useNetworkState } from 'expo-network';

export function useNetwork(): boolean {
  const state = useNetworkState();
  // Optimistic until the first reading arrives (state fields start undefined);
  // only a definitive `false` flips us offline.
  return state.isConnected !== false;
}
