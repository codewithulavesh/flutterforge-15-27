import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { HERO_PROMPT_KEY } from '@/utils/landing';
import { LoginPage } from './LoginPage';
import { SignupPage } from './SignupPage';
import { ForgotPasswordPage } from './ForgotPasswordPage';

vi.mock('@/services/supabase', () => ({ isSupabaseConfigured: false, supabase: null }));

beforeEach(() => {
  useAuthStore.setState({ session: null, user: null, initialized: true, loading: false, error: null });
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Destination() {
  const location = useLocation();
  return <output aria-label="Destination">{location.pathname}</output>;
}

describe('LoginPage', () => {
  function renderLoginPage() {
    return render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<Destination />} />
          <Route path="/forgot-password" element={<Destination />} />
          <Route path="/dashboard" element={<Destination />} />
          <Route path="/" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('renders the Lime & Agents design elements on login page', () => {
    renderLoginPage();

    // Panchang branding and headlines
    expect(screen.getByRole('link', { name: 'FlutterForge home' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getAllByText(/Welcome back/i)[0]).toBeInTheDocument();

    // Input fields
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();

    // Action button
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();

    // Navigation links
    expect(screen.getAllByRole('link', { name: /create account/i })[0]).toHaveAttribute('href', '/signup');
    expect(screen.getByRole('link', { name: 'Forgot?' })).toHaveAttribute('href', '/forgot-password');
  });

  it('validates empty inputs and displays alert', async () => {
    const user = userEvent.setup();
    renderLoginPage();

    const submitBtn = screen.getByRole('button', { name: 'Sign In' });
    await user.click(submitBtn);

    expect(screen.getByRole('alert')).toHaveTextContent('Please enter your email and password.');
  });

  it('calls signIn on submit and navigates to dashboard on success', async () => {
    const signInMock = vi.fn().mockResolvedValue({ error: null });
    useAuthStore.setState({ signIn: signInMock });

    const user = userEvent.setup();
    renderLoginPage();

    await user.type(screen.getByLabelText('Email address'), 'developer@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(signInMock).toHaveBeenCalledWith('developer@example.com', 'password123');
    expect(await screen.findByLabelText('Destination')).toHaveTextContent('/dashboard');
  });
});

describe('SignupPage', () => {
  function renderSignupPage(initialState?: unknown) {
    return render(
      <MemoryRouter initialEntries={[{ pathname: '/signup', state: initialState }]}>
        <Routes>
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/login" element={<Destination />} />
          <Route path="/dashboard" element={<Destination />} />
          <Route path="/" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('renders the Lime & Agents design elements on registration page', () => {
    renderSignupPage();

    // Panchang branding and headlines
    expect(screen.getByRole('link', { name: 'FlutterForge home' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Create Account' })).toBeInTheDocument();
    expect(screen.getByText(/The next app/i)).toBeInTheDocument();

    // Input fields
    expect(screen.getByLabelText('Full name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();

    // Submit button
    expect(screen.getByRole('button', { name: 'Create Account' })).toBeInTheDocument();

    // Navigation links
    expect(screen.getAllByRole('link', { name: /sign in/i })[0]).toHaveAttribute('href', '/login');
  });

  it('displays the brief entered on the landing page or agents page', () => {
    sessionStorage.setItem(HERO_PROMPT_KEY, 'Build a fitness timer');
    renderSignupPage();

    expect(screen.getByText('Your App Brief')).toBeInTheDocument();
    expect(screen.getByText(/Build a fitness timer/)).toBeInTheDocument();
  });

  it('validates password length and displays error', async () => {
    const user = userEvent.setup();
    renderSignupPage();

    await user.type(screen.getByLabelText('Full name'), 'Alex');
    await user.type(screen.getByLabelText('Email address'), 'alex@example.com');
    await user.type(screen.getByLabelText('Password'), '123');
    await user.click(screen.getByRole('button', { name: 'Create Account' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 6 characters.');
  });

  it('calls signUp and handles success confirmation', async () => {
    const signUpMock = vi.fn().mockResolvedValue({ error: null });
    useAuthStore.setState({ signUp: signUpMock, session: null });

    const user = userEvent.setup();
    renderSignupPage();

    await user.type(screen.getByLabelText('Full name'), 'Alex Taylor');
    await user.type(screen.getByLabelText('Email address'), 'alex@example.com');
    await user.type(screen.getByLabelText('Password'), 'secretPass123');
    await user.click(screen.getByRole('button', { name: 'Create Account' }));

    expect(signUpMock).toHaveBeenCalledWith('alex@example.com', 'secretPass123', 'Alex Taylor');
    expect(await screen.findByRole('status')).toHaveTextContent('Account created. Check your email');
  });
});

describe('ForgotPasswordPage', () => {
  it('renders reset form and submits recovery request', async () => {
    const resetMock = vi.fn().mockResolvedValue({ error: null });
    useAuthStore.setState({ resetPassword: resetMock });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/forgot-password']}>
        <Routes>
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/login" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Reset Password' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email address'), 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'Send Reset Link' }));

    expect(resetMock).toHaveBeenCalledWith('user@example.com');
    expect(await screen.findByRole('status')).toHaveTextContent('Check your email for a reset link.');
  });
});
