# Mobile React Native Stack Profile

## Languages & Frameworks
- **Framework**: React Native + Expo SDK 50+
- **Language**: TypeScript strict
- **Styling**: NativeWind (Tailwind for RN) or StyleSheet API
- **Navigation**: Expo Router (file-based) or React Navigation v6
- **State**: Zustand + React Query
- **Storage**: AsyncStorage + Expo SecureStore for sensitive data
- **APIs**: Axios + React Query for data fetching

## Coding Standards
- Expo managed workflow preferred; bare workflow for native modules
- Platform-specific code: `.ios.ts` / `.android.ts` suffixes
- Avoid inline styles — use StyleSheet.create() or NativeWind
- All async operations must be wrapped in error boundaries
- Use Expo constants for environment variables

## Project Structure
```
app/           # Expo Router screens
  (tabs)/      # Tab navigator group
  (auth)/      # Auth screens
components/    # Reusable components
hooks/         # Custom hooks
lib/           # Utilities, API clients
store/         # Zustand stores
assets/        # Images, fonts
```

## Testing Stack
- **Unit**: Jest + @testing-library/react-native
- **E2E**: Detox
- **File naming**: `*.test.tsx` or `*.spec.tsx`
- **Mocking**: jest.mock() for native modules

## Common Patterns
- Navigation: useRouter() hook from expo-router
- Images: expo-image for caching, expo-asset for local
- Permissions: expo-permissions → individual expo packages
- Push notifications: expo-notifications
