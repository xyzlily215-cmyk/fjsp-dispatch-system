package com.fjsp.business.auth;

import com.fjsp.business.entity.AppUser;
import com.fjsp.business.repository.AppUserRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.security.crypto.password.PasswordEncoder;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class UserSeedRunnerTest {

    @Mock
    private AppUserRepository userRepository;
    @Mock
    private PasswordEncoder passwordEncoder;

    private UserSeedRunner runner(MockEnvironment environment) {
        return new UserSeedRunner(userRepository, passwordEncoder, environment);
    }

    @Test
    void nonProd_usesBuiltinDemoPassword() {
        MockEnvironment environment = new MockEnvironment();
        when(userRepository.existsByUsername(anyString())).thenReturn(false);
        when(passwordEncoder.encode(anyString())).thenReturn("hash");

        runner(environment).run(null);

        verify(passwordEncoder, times(4)).encode(UserSeedRunner.SEED_PASSWORD);
        verify(userRepository, times(4)).save(any(AppUser.class));
    }

    @Test
    void prod_withoutEnvPassword_failsFast() {
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("prod");

        IllegalStateException e = assertThrows(IllegalStateException.class, () -> runner(environment).run(null));

        assertTrue(e.getMessage().contains(UserSeedRunner.SEED_PASSWORD_ENV));
        verifyNoInteractions(userRepository, passwordEncoder);
    }

    @Test
    void prod_withEnvPassword_usesProvidedPassword() {
        MockEnvironment environment = new MockEnvironment()
                .withProperty(UserSeedRunner.SEED_PASSWORD_ENV, "prod-initial-password");
        environment.setActiveProfiles("prod");
        when(userRepository.existsByUsername(anyString())).thenReturn(false);
        when(passwordEncoder.encode(anyString())).thenReturn("hash");

        runner(environment).run(null);

        verify(passwordEncoder, times(4)).encode("prod-initial-password");
        verify(userRepository, times(4)).save(any(AppUser.class));
    }

    @Test
    void existingUser_skipped() {
        MockEnvironment environment = new MockEnvironment();
        when(userRepository.existsByUsername(anyString())).thenReturn(true);

        runner(environment).run(null);

        verify(userRepository, times(4)).existsByUsername(anyString());
        verifyNoInteractions(passwordEncoder);
    }
}
