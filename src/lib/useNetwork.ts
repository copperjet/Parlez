/**
 * Network reachability (spec §10.2, §11.3). Drives the offline banner and the
 * "full conversation needs internet" degradation.
 */
import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

export function useNetwork(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    NetInfo.fetch().then((s) => setOnline(s.isConnected !== false));
    const unsubscribe = NetInfo.addEventListener((s) =>
      setOnline(s.isConnected !== false),
    );
    return unsubscribe;
  }, []);

  return online;
}
