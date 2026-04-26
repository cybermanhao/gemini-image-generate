import { ToastProvider } from './hooks/useToast.tsx';
import { Studio } from './components/Studio.tsx';

export function App() {
  return (
    <ToastProvider>
      <div className="flex h-full flex-col">
        <Studio />
      </div>
    </ToastProvider>
  );
}
