package com.fjsp.business.auth;

import java.util.List;
import java.util.UUID;

import com.fjsp.business.entity.AppUser;
import com.fjsp.business.repository.AppUserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

/**
 * 启动时补齐 4 个种子账号（按 username 幂等），是所有 profile 下账号种子的唯一来源
 * （Flyway V3 只建 app_user 表，不再插入账号）。
 * 密码按 profile 区分：local/test/默认 profile 用内置演示密码（见 README）；
 * prod profile 强制从环境变量 FJSP_SEED_ADMIN_PASSWORD 读取，缺失即启动失败。
 */
@Component
public class UserSeedRunner implements ApplicationRunner {

    /**
     * 内置演示密码（Fj@123456），仅 local/test/默认 profile 的种子账号使用；
     * prod profile 禁止使用（见 {@link #resolveSeedPassword()}）。
     */
    public static final String SEED_PASSWORD = "Fj@123456";

    /** prod profile 下初始账号密码来源（环境变量），缺失即启动失败，禁止使用内置演示密码。 */
    public static final String SEED_PASSWORD_ENV = "FJSP_SEED_ADMIN_PASSWORD";

    private static final Logger log = LoggerFactory.getLogger(UserSeedRunner.class);

    private record SeedUser(String username, String role, String displayName) {
    }

    private static final List<SeedUser> SEED_USERS = List.of(
            new SeedUser("dispatcher", "DISPATCHER", "调度员"),
            new SeedUser("reviewer", "REVIEWER", "审核员"),
            new SeedUser("manager", "PRODUCTION_MANAGER", "生产主管"),
            new SeedUser("admin", "ADMIN", "管理员"));

    private final AppUserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final Environment environment;

    public UserSeedRunner(AppUserRepository userRepository, PasswordEncoder passwordEncoder,
                          Environment environment) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.environment = environment;
    }

    @Override
    public void run(ApplicationArguments args) {
        String seedPassword = resolveSeedPassword();
        for (SeedUser seed : SEED_USERS) {
            if (userRepository.existsByUsername(seed.username())) {
                continue;
            }
            AppUser user = new AppUser();
            user.setId(UUID.randomUUID().toString());
            user.setUsername(seed.username());
            user.setPasswordHash(passwordEncoder.encode(seedPassword));
            user.setRole(seed.role());
            user.setDisplayName(seed.displayName());
            user.setEnabled(true);
            userRepository.save(user);
            log.info("seeded initial user {} ({})", seed.username(), seed.role());
        }
    }

    private String resolveSeedPassword() {
        if (!environment.acceptsProfiles(Profiles.of("prod"))) {
            return SEED_PASSWORD;
        }
        String password = environment.getProperty(SEED_PASSWORD_ENV);
        if (password == null || password.isBlank()) {
            throw new IllegalStateException(
                    "prod profile 下禁止使用内置演示密码 seed 初始账号：请通过环境变量 "
                            + SEED_PASSWORD_ENV + " 提供初始密码，缺失即启动失败");
        }
        return password;
    }
}
